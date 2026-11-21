// Runs src/plugin/index.js against a fake Pebble host: `node --test test/`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'src', 'plugin', 'index.js'), 'utf8');
const NOW_SEC = Math.floor(Date.now() / 1000);

function sampleBody() {
  return {
    user: { administrative: { lang: 'cs', reg_locale: 'cs-CZ', unit: 0, windunit: 0, pressureunit: 0 } },
    devices: [{
      _id: '70:ee:50:00:00:01', type: 'NAMain', home_name: 'Chata', module_name: 'Obývák',
      reachable: true,
      dashboard_data: {
        time_utc: NOW_SEC - 120, Temperature: 21.4, CO2: 612, Humidity: 48, Noise: 38,
        Pressure: 1013.2, AbsolutePressure: 980.1, min_temp: 20.1, max_temp: 22.6,
        temp_trend: 'stable', pressure_trend: 'up',
      },
      modules: [
        { _id: '06:00:00:00:00:04', type: 'NAModule4', module_name: 'Ložnice', battery_percent: 77, reachable: true,
          dashboard_data: { time_utc: NOW_SEC - 150, Temperature: 19.0, CO2: 980, Humidity: 55 } },
        { _id: '02:00:00:00:00:01', type: 'NAModule1', module_name: '', battery_percent: 64, reachable: true,
          dashboard_data: { time_utc: NOW_SEC - 100, Temperature: -0.04, Humidity: 91, min_temp: -3.2, max_temp: 4.5, temp_trend: 'down' } },
        { _id: '05:00:00:00:00:03', type: 'NAModule3', module_name: 'Déšť', battery_percent: 90, reachable: true,
          dashboard_data: { time_utc: NOW_SEC - 100, Rain: 0.101, sum_rain_1: 0.4, sum_rain_24: 3.2 } },
        { _id: '06:00:00:00:00:02', type: 'NAModule2', module_name: 'Vítr', battery_percent: 50, reachable: false,
          dashboard_data: { time_utc: NOW_SEC - 100, WindStrength: 18, WindAngle: 225, GustStrength: 32, GustAngle: -1 } },
      ],
    }],
  };
}

function host(opts = {}) {
  const secure = new Map(Object.entries(opts.secure || {}));
  const local = new Map(Object.entries(opts.local || {}));
  const calls = { fetch: [], refreshSources: [], oauthRefresh: 0, oauthAuthorize: 0 };
  const handlers = {};
  const units = opts.units || { locale: 'cs-CZ', temperature: '°C', wind_speed: 'km/h', pressure: 'hPa', precipitation: 'mm', clock: '24h' };

  const fetchImpl = opts.fetch || (async (url, init) => {
    const auth = init && init.headers && init.headers.Authorization;
    if (opts.validToken && auth !== 'Bearer ' + opts.validToken) {
      return { status: 403, text: async () => JSON.stringify({ error: { code: 3, message: 'Access token expired' } }) };
    }
    return { status: 200, text: async () => JSON.stringify({ status: 'ok', body: opts.body || sampleBody() }) };
  });

  const Pebble = {
    registerSourceHandler: (fn) => { handlers.source = fn; },
    registerConfigHandler: (fn) => { handlers.config = fn; },
    subscribeSource: () => {},
    readSource: async (req) => {
      if (req.category !== 'preferences' || req.item !== 'units' || opts.noUnits) throw new Error('PLUGIN_UNAVAILABLE');
      const properties = {};
      for (const [k, v] of Object.entries(units)) properties[k] = { shortText: { text: v } };
      return { instances: [{ instanceId: 'units', properties }] };
    },
    refreshSources: (s) => calls.refreshSources.push(plain(s)),
    secureStorage: {
      getItem: async (k) => (secure.has(k) ? secure.get(k) : null),
      setItem: async (k, v) => { secure.set(k, v); },
      removeItem: async (k) => { secure.delete(k); },
    },
    oauth: {
      authorize: async () => { calls.oauthAuthorize++; return { access_token: 'tok-new', broker_refresh: 'br-new', expires_in: 10800 }; },
      refresh: async (slug, br) => {
        calls.oauthRefresh++;
        assert.equal(slug, 'netatmo');
        assert.equal(br, 'br-1');
        return { access_token: 'tok-2', expires_in: 10800 };
      },
    },
  };
  const localStorage = {
    getItem: (k) => (local.has(k) ? local.get(k) : null),
    setItem: (k, v) => local.set(k, String(v)),
    removeItem: (k) => local.delete(k),
  };
  const fetch = async (url, init) => { calls.fetch.push(url); return fetchImpl(url, init); };
  vm.runInNewContext(SCRIPT, { Pebble, localStorage, fetch, console: { log() {}, error() {} }, Date, JSON, Math });
  return { handlers, calls, secure, local };
}

// Objects from the vm context have its prototypes; deepEqual wants this realm's.
const plain = (v) => JSON.parse(JSON.stringify(v));

function readSource(h, item = 'netatmo') {
  return new Promise((resolve) => {
    h.handlers.source({ category: 'weather', item }, {
      data: (d) => resolve({ data: plain(d) }),
      error: (code, message) => resolve({ error: { code, message } }),
    });
  });
}

function config(h, message) {
  return new Promise((resolve) => h.handlers.config(message, (r) => resolve(plain(r))));
}

const SIGNED_IN = { secure: { netatmo_access_token: 'tok-1', netatmo_broker_refresh: 'br-1' } };

test('not signed in: AUTH_REQUIRED, no network', async () => {
  const h = host();
  const r = await readSource(h);
  assert.equal(r.error.code, 'AUTH_REQUIRED');
  assert.match(r.error.message, /Netatmo/);
  assert.equal(h.calls.fetch.length, 0);
});

test('the pre-1.1.0 item weather/station is answered too', async () => {
  const h = host(SIGNED_IN);
  const [a, b] = [await readSource(h, 'netatmo'), await readSource(h, 'station')];
  assert.equal(a.data.instances.length, 5);
  assert.deepEqual(b.data.instances, a.data.instances);
  assert.equal((await readSource(h, 'location')).error.code, 'INVALID_REQUEST');
});

test('modules in display order with stable ids', async () => {
  const r = await readSource(host(SIGNED_IN));
  assert.deepEqual(r.data.instances.map((i) => i.instanceId), [
    '02:00:00:00:00:01', '70:ee:50:00:00:01', '06:00:00:00:00:04', '05:00:00:00:00:03', '06:00:00:00:00:02',
  ]);
});

test('metric readings in the Czech locale', async () => {
  const r = await readSource(host(SIGNED_IN));
  const [outdoor, base, , rain, wind] = r.data.instances.map((i) => i.properties);

  assert.equal(outdoor.name.shortText.text, 'Chata - Venku');    // empty module name -> default
  assert.equal(outdoor.name.longText.text, 'Chata - Venku');
  assert.equal(outdoor.station.shortText.text, 'Chata');
  assert.equal(outdoor.module_type.shortText.text, 'outdoor');
  assert.equal(outdoor.temperature.shortText.text, '0,0°C');     // no "-0"
  assert.deepEqual(outdoor.low.numericValue, { value: -3.2, unit: '°C' });
  assert.equal(outdoor.temperature_trend.longText.text, 'Klesá');
  assert.deepEqual(outdoor.humidity.numericValue, { value: 91, unit: '%', min: 0, max: 100 });
  assert.equal(outdoor.battery.shortText.text, '64%');

  assert.equal(base.co2.shortText.text, '612ppm');
  assert.equal(base.co2.longText.text, '612 ppm');
  assert.equal(base.pressure.shortText.text, '1013hPa');
  assert.equal(base.pressure.longText.text, '1013,2 hPa');
  assert.equal(base.noise.shortText.text, '38dB');
  assert.equal(base.battery, undefined);                          // mains powered
  assert.equal(base.updated.timestamp.value, NOW_SEC - 120);
  assert.match(base.updated.shortText.text, /^\d\d:\d\d$/);

  assert.equal(rain.rain_today.shortText.text, '3,2mm');
  assert.equal(rain.rain.numericValue.value, 0.1);

  assert.equal(wind.wind_speed.shortText.text, '18km/h');
  assert.equal(wind.wind_direction.shortText.text, 'JZ');
  assert.equal(wind.wind_direction.longText.text, 'JZ (225°)');
  assert.equal(wind.gust_direction, undefined);                   // negative angle = calm
  assert.deepEqual(wind.reachable, { boolean: { value: false }, shortText: { text: 'Offline' } });

  for (const inst of r.data.instances) {
    for (const [name, prop] of Object.entries(inst.properties)) {
      if (prop.shortText && name !== 'name' && name !== 'station') {
        assert.ok(prop.shortText.text.length <= 7, `${name} shortText "${prop.shortText.text}" too long`);
      }
    }
  }
});

test('settings page says when the language comes from the Netatmo account', async () => {
  const status = await config(host({ ...SIGNED_IN, noUnits: true }), { type: 'status' });
  assert.equal(status.locale, 'cs-CZ');
  assert.equal(status.localeFrom, 'netatmo');
});

test('other languages get English words with their own decimal separator', async () => {
  const r = await readSource(host({
    ...SIGNED_IN,
    units: { locale: 'de-DE', temperature: '°C', wind_speed: 'km/h', pressure: 'hPa', precipitation: 'mm', clock: '24h' },
  }));
  const [outdoor, , , , wind] = r.data.instances.map((i) => i.properties);
  assert.equal(outdoor.name.shortText.text, 'Chata - Outdoor');
  assert.equal(outdoor.temperature_trend.longText.text, 'Falling');
  assert.equal(outdoor.low.shortText.text, '-3,2°C');
  assert.equal(wind.wind_direction.shortText.text, 'SW');
});

test('imperial units in English', async () => {
  const r = await readSource(host({
    ...SIGNED_IN,
    units: { locale: 'en-US', temperature: '°F', wind_speed: 'mph', pressure: 'inHg', precipitation: 'in', clock: '12h' },
  }));
  const [outdoor, base, , rain, wind] = r.data.instances.map((i) => i.properties);
  assert.equal(outdoor.name.shortText.text, 'Chata - Outdoor');
  assert.equal(outdoor.high.shortText.text, '40.1°F');
  assert.equal(base.pressure.shortText.text, '29.92in');
  assert.equal(base.pressure.longText.text, '29.92 inHg');
  assert.equal(rain.rain_today.longText.text, '0.13 in');
  assert.equal(wind.wind_speed.shortText.text, '11mph');
  assert.equal(wind.wind_direction.shortText.text, 'SW');
  assert.match(base.updated.shortText.text, /^\d{1,2}:\d\d[ap]m$/);
});

test('without preferences/units falls back to Netatmo account settings', async () => {
  const body = sampleBody();
  body.user.administrative = { lang: 'en', unit: 1, windunit: 4, pressureunit: 1 };
  const r = await readSource(host({ ...SIGNED_IN, noUnits: true, body }));
  const wind = r.data.instances[4].properties;
  assert.equal(wind.wind_speed.shortText.text, '10kn');
  assert.equal(r.data.instances[0].properties.temperature.numericValue.unit, '°F');
});

test('validUntilMs is the refresh interval, 15 min by default', async () => {
  const r = await readSource(host(SIGNED_IN));
  assert.ok(Math.abs(r.data.validUntilMs - (Date.now() + 15 * 60 * 1000)) < 2000);
});

function cachedAgo(minutes) {
  return JSON.stringify({ at: Date.now() - minutes * 60 * 1000, body: sampleBody() });
}

test('cache is reused until the interval is nearly up', async () => {
  let h = host({ ...SIGNED_IN, local: { 'netatmo.refresh_min': '30', 'netatmo.data.v1': cachedAgo(20) } });
  await readSource(h);
  assert.equal(h.calls.fetch.length, 0);

  // The host polls every 15 min with jitter: 29 min into a 30 min interval is due.
  h = host({ ...SIGNED_IN, local: { 'netatmo.refresh_min': '30', 'netatmo.data.v1': cachedAgo(29) } });
  await readSource(h);
  assert.equal(h.calls.fetch.length, 1);

  h = host({ ...SIGNED_IN, local: { 'netatmo.refresh_min': '360', 'netatmo.data.v1': cachedAgo(300) } });
  const r = await readSource(h);
  assert.equal(h.calls.fetch.length, 0);
  assert.ok(Math.abs(r.data.validUntilMs - (Date.now() + 60 * 60 * 1000)) < 2000);
});

test('an unknown stored interval falls back to 15 min', async () => {
  const h = host({ ...SIGNED_IN, local: { 'netatmo.refresh_min': '7', 'netatmo.data.v1': cachedAgo(16) } });
  await readSource(h);
  assert.equal(h.calls.fetch.length, 1);
});

test('settings page: interval is offered, stored and validated', async () => {
  const h = host(SIGNED_IN);
  const status = await config(h, { type: 'status' });
  assert.equal(status.interval, 15);
  assert.equal(status.locale, 'cs-CZ');                           // the readings' language
  assert.equal(status.localeFrom, 'pebble');
  assert.deepEqual(status.intervals, [15, 30, 60, 360]);

  assert.deepEqual(await config(h, { type: 'setInterval', minutes: 60 }), { interval: 60 });
  assert.equal(h.local.get('netatmo.refresh_min'), '60');
  assert.deepEqual(h.calls.refreshSources.at(-1), ['weather/netatmo', 'weather/station']);
  assert.ok((await config(h, { type: 'setInterval', minutes: 5 })).error);
  assert.equal(h.local.get('netatmo.refresh_min'), '60');
});

test('second read within the upload period uses the cache', async () => {
  const h = host(SIGNED_IN);
  await readSource(h);
  await readSource(h);
  assert.equal(h.calls.fetch.length, 1);
});

test('expired token is renewed through the broker and retried', async () => {
  const h = host({ ...SIGNED_IN, validToken: 'tok-2' });
  const r = await readSource(h);
  assert.ok(r.data, JSON.stringify(r.error));
  assert.equal(h.calls.oauthRefresh, 1);
  assert.equal(h.calls.fetch.length, 2);
  assert.equal(h.secure.get('netatmo_access_token'), 'tok-2');
  assert.equal(h.secure.get('netatmo_broker_refresh'), 'br-1');   // kept when not rotated
});

test('token past expires_at is refreshed before the request', async () => {
  const h = host({ ...SIGNED_IN, local: { 'netatmo.expires_at': String(Date.now() - 1000) }, validToken: 'tok-2' });
  const r = await readSource(h);
  assert.ok(r.data);
  assert.equal(h.calls.fetch.length, 1);
});

test('rejected refresh means AUTH_REQUIRED', async () => {
  const h = host({ ...SIGNED_IN, validToken: 'never' });
  const r = await readSource(h);
  assert.equal(r.error.code, 'AUTH_REQUIRED');
});

test('rate limit is reported as RATE_LIMITED', async () => {
  const h = host({ ...SIGNED_IN, fetch: async () => ({ status: 403, text: async () => '{"error":{"code":26,"message":"User usage reached"}}' }) });
  assert.equal((await readSource(h)).error.code, 'RATE_LIMITED');
});

test('network failure serves a recent cached reading', async () => {
  const cache = cachedAgo(20);
  const h = host({ ...SIGNED_IN, local: { 'netatmo.data.v1': cache }, fetch: async () => { throw new TypeError('offline'); } });
  const r = await readSource(h);
  assert.equal(r.data.instances.length, 5);
});

test('network failure without cache is PLUGIN_UNAVAILABLE', async () => {
  const h = host({ ...SIGNED_IN, fetch: async () => { throw new TypeError('offline'); } });
  assert.equal((await readSource(h)).error.code, 'PLUGIN_UNAVAILABLE');
});

test('settings page: connect, status, unlink', async () => {
  const h = host();
  assert.equal((await config(h, { type: 'status' })).connected, false);

  const connected = await config(h, { type: 'connect' });
  assert.equal(connected.connected, true);
  assert.equal(connected.modules.length, 5);
  assert.equal(connected.modules[0].type, 'outdoor');
  assert.ok(connected.modules[1].rows.some((r) => r[0] === 'co2' && r[1] === '612 ppm'));
  assert.equal(h.secure.get('netatmo_access_token'), 'tok-new');
  assert.equal(h.secure.get('netatmo_broker_refresh'), 'br-new');
  assert.deepEqual(h.calls.refreshSources.at(-1), ['weather/netatmo', 'weather/station']);
  assert.equal(connected.modules[0].name, 'Chata - Venku');

  const status = await config(h, { type: 'status' });
  assert.equal(status.modules.length, 5);
  assert.equal(h.calls.fetch.length, 1);                          // from cache

  assert.equal((await config(h, { type: 'unlink' })).connected, false);
  assert.equal(h.secure.size, 0);
  assert.equal(h.local.get('netatmo.data.v1'), undefined);
});

test('settings page: a token Netatmo rejects is not kept', async () => {
  const h = host({ validToken: 'something-else' });
  const reply = await config(h, { type: 'connect' });
  assert.equal(reply.connected, false);
  assert.ok(reply.error);
  assert.equal(h.secure.size, 0);
});
