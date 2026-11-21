// Netatmo Weather: readings from the user's Netatmo Smart Weather Stations as `weather/netatmo`.
//
// One instance per module, in a stable order (per station: outdoor, base station, extra indoor,
// rain gauge, anemometer), so instances[0] is the outdoor module of the first station.
// instanceId is the module's MAC address, so a choice stored by an app survives reordering.
// Each is named "Station - Module".
//
// Netatmo is asked at most once per refresh interval the user picks on the settings page
// (15 min, 30 min, 1 h or 6 h); requests in between are answered from localStorage.
//
// Sign-in goes through the Pebble appstore's OAuth broker (connector slug "netatmo"), so the
// Netatmo client secret never ships in the pbw. Tokens live in Pebble.secureStorage.
//
// The plugin is started fresh for every request: all state is in (secure) storage.

var API_ROOT = 'https://api.netatmo.com/api';
var CONNECTOR = 'netatmo';
// weather/station is the item's name before 1.1.0. The app store kept serving the 1.0.0 manifest
// with later releases, so apps may still ask for it: both are answered the same.
var ITEMS = ['netatmo', 'station'];
var SOURCES = ITEMS.map(function (item) { return 'weather/' + item; });

var TOKEN_KEY = 'netatmo_access_token';
var BROKER_REFRESH_KEY = 'netatmo_broker_refresh';
var EXPIRES_AT_KEY = 'netatmo.expires_at';
var CACHE_KEY = 'netatmo.data.v1';
var BLOCKED_KEY = 'netatmo.blocked.v1';
var INTERVAL_KEY = 'netatmo.refresh_min';


// Refresh intervals offered on the settings page, in minutes.
var INTERVALS = [15, 30, 60, 360];
var DEFAULT_INTERVAL = 15;
// The host polls every suggestedRefreshIntervalSec (15 min) with some jitter: data this close to
// its interval's end counts as due, so a 30 min interval doesn't slip to 45.
var DUE_SLACK_MS = 90 * 1000;
var MIN_FETCH_GAP_MS = 60 * 1000;
// When Netatmo can't be reached, data up to an interval (at least an hour) old beats none.
var STALE_FALLBACK_MS = 60 * 60 * 1000;

var UNITS = { category: 'preferences', item: 'units' };

// Netatmo error codes (body.error.code) that mean the access token is no good.
var TOKEN_ERROR_CODES = [2, 3];
var RATE_LIMIT_CODE = 26;

// ---------------------------------------------------------------- texts

var TEXTS = {
  en: {
    outdoor: 'Outdoor', indoor: 'Indoor', rain: 'Rain gauge', wind: 'Wind gauge',
    up: ['Rising', 'Rising'], down: ['Falling', 'Falling'], stable: ['Steady', 'Steady'],
    online: 'Online', offline: 'Offline',
    compass: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
    notConnected: 'Sign in to Netatmo on the plugin\'s settings page.',
    authFailed: 'Netatmo sign-in expired. Sign in again on the plugin\'s settings page.',
    rateLimited: 'Netatmo is limiting requests. Try again later.',
    unreachable: 'Could not reach Netatmo.',
    noStations: 'No weather station found in this Netatmo account.',
  },
  cs: {
    outdoor: 'Venku', indoor: 'Uvnitř', rain: 'Srážkoměr', wind: 'Anemometr',
    up: ['Roste', 'Stoupá'], down: ['Klesá', 'Klesá'], stable: ['Drží', 'Beze změny'],
    online: 'Online', offline: 'Offline',
    compass: ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'],
    notConnected: 'Přihlaste se k Netatmo v nastavení pluginu.',
    authFailed: 'Přihlášení k Netatmo vypršelo. Přihlaste se znovu v nastavení pluginu.',
    rateLimited: 'Netatmo omezuje počet požadavků. Zkuste to později.',
    unreachable: 'Netatmo není dostupné.',
    noStations: 'V účtu Netatmo není žádná meteostanice.',
  },
};

function texts(locale) {
  var lang = String(locale || '').toLowerCase().split(/[-_]/)[0];
  return TEXTS[lang] || TEXTS.en;
}

// ---------------------------------------------------------------- user preferences

/** The user's units from `preferences/units`, else Netatmo's account settings, else metric. */
// preferences/units' locale is the language the watch reports when it connects (its language
// pack), else the phone's. Only Czech and English texts exist; any other language gets English
// words with its own decimal separator.
async function userUnits(administrative) {
  var adm = administrative || {};
  var fallback = {
    locale: adm.reg_locale || adm.lang || 'en',
    temperature: adm.unit === 1 ? '°F' : '°C',
    wind_speed: ['km/h', 'mph', 'm/s', 'km/h', 'knots'][adm.windunit] || 'km/h',
    pressure: adm.pressureunit === 1 ? 'inHg' : 'hPa',
    precipitation: adm.unit === 1 ? 'in' : 'mm',
    clock: '24h',
    // Where the language came from: 'pebble' (preferences/units), 'netatmo' or 'default'.
    localeFrom: adm.reg_locale || adm.lang ? 'netatmo' : 'default',
  };
  try {
    var p = (await Pebble.readSource(UNITS)).instances[0].properties;
    var pick = function (name) {
      var v = p[name] && p[name].shortText && p[name].shortText.text;
      return v || fallback[name];
    };
    var locale = p.locale && p.locale.shortText && p.locale.shortText.text;
    console.log('Netatmo: preferences/units locale=' + locale + ' temperature=' + pick('temperature'));
    return {
      localeFrom: locale ? 'pebble' : fallback.localeFrom,
      locale: pick('locale'),
      temperature: pick('temperature'),
      wind_speed: pick('wind_speed'),
      pressure: pick('pressure'),
      precipitation: pick('precipitation'),
      clock: pick('clock'),
    };
  } catch (e) {
    console.log('Netatmo: preferences/units unavailable (' + ((e && (e.code || e.message)) || e) +
      '), using ' + fallback.localeFrom + ' locale ' + fallback.locale);
    return fallback;
  }
}

var COMMA_LANGUAGES = ['cs', 'sk', 'de', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'ru', 'uk', 'sv',
  'da', 'nb', 'no', 'fi', 'hu', 'tr', 'ro', 'bg', 'hr', 'sl', 'sr', 'el', 'lt', 'lv', 'et', 'ca'];

function decimalSeparator(locale) {
  try {
    var s = (1.5).toLocaleString(locale);
    if (s === '1,5') return ',';
    if (s === '1.5') return '.';
  } catch (e) {}
  var lang = String(locale || '').toLowerCase().split(/[-_]/)[0];
  return COMMA_LANGUAGES.indexOf(lang) >= 0 ? ',' : '.';
}

/** `value` with `decimals` places and the locale's decimal separator; "-0" is shown as "0". */
function formatNumber(value, decimals, sep) {
  var text = Number(value).toFixed(decimals);
  if (/^-0(\.0*)?$/.test(text)) text = text.slice(1);
  return sep === ',' ? text.replace('.', ',') : text;
}

function round(value, decimals) {
  var f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ---------------------------------------------------------------- readings

/**
 * One property with every text shape plus numericValue.
 * `short` has no space before the unit and may use fewer decimals, to fit ~7 characters.
 */
function reading(value, unit, decimals, sep, opts) {
  opts = opts || {};
  var shortDecimals = opts.shortDecimals === undefined ? decimals : opts.shortDecimals;
  var shortUnit = opts.shortUnit === undefined ? unit : opts.shortUnit;
  var longUnit = opts.longUnit === undefined ? unit : opts.longUnit;
  var numeric = { value: round(value, decimals), unit: unit };
  if (opts.min !== undefined) numeric.min = opts.min;
  if (opts.max !== undefined) numeric.max = opts.max;
  var spaced = longUnit === '%' || longUnit === '°C' || longUnit === '°F' || longUnit === '°' ? '' : ' ';
  return {
    shortText: { text: formatNumber(value, shortDecimals, sep) + shortUnit },
    longText: { text: formatNumber(value, decimals, sep) + spaced + longUnit },
    numericValue: numeric,
  };
}

function temperatureReading(celsius, units, sep) {
  var f = units.temperature === '°F';
  return reading(f ? celsius * 9 / 5 + 32 : celsius, f ? '°F' : '°C', 1, sep);
}

function pressureReading(hpa, units, sep) {
  if (units.pressure === 'inHg') {
    return reading(hpa * 0.0295299830714, 'inHg', 2, sep, { shortUnit: 'in' });
  }
  return reading(hpa, 'hPa', 1, sep, { shortDecimals: 0 });
}

function rainReading(mm, units, sep) {
  if (units.precipitation === 'in') return reading(mm / 25.4, 'in', 2, sep);
  return reading(mm, 'mm', 1, sep);
}

/** Netatmo reports wind in km/h. */
function windReading(kmh, units, sep) {
  switch (units.wind_speed) {
    case 'm/s': return reading(kmh / 3.6, 'm/s', 1, sep);
    case 'mph': return reading(kmh * 0.621371, 'mph', 0, sep);
    case 'knots': return reading(kmh * 0.539957, 'knots', 0, sep, { shortUnit: 'kn' });
    default: return reading(kmh, 'km/h', 0, sep);
  }
}

function directionReading(degrees, t) {
  var point = t.compass[Math.round(((degrees % 360) + 360) % 360 / 45) % 8];
  return {
    shortText: { text: point },
    longText: { text: point + ' (' + Math.round(degrees) + '°)' },
    numericValue: { value: Math.round(degrees), unit: '°', min: 0, max: 360 },
  };
}

function trendReading(trend, t) {
  var words = t[trend];
  if (!words) return null;
  return { shortText: { text: words[0] }, longText: { text: words[1] } };
}

function text(value) {
  return { shortText: { text: String(value) }, longText: { text: String(value) } };
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function clockText(epochSec, clock) {
  var d = new Date(epochSec * 1000);
  var h = d.getHours();
  var m = pad(d.getMinutes());
  if (clock === '12h') return ((h % 12) || 12) + ':' + m + (h < 12 ? 'am' : 'pm');
  return pad(h) + ':' + m;
}

function isNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

// ---------------------------------------------------------------- modules -> instances

var TYPE_OF = { NAMain: 'indoor', NAModule1: 'outdoor', NAModule2: 'wind', NAModule3: 'rain', NAModule4: 'indoor' };
var ORDER = { NAModule1: 0, NAMain: 1, NAModule4: 2, NAModule3: 3, NAModule2: 4 };

/** The station's modules in display order, the base station among them. */
function orderedModules(device) {
  var all = [device].concat(Array.isArray(device.modules) ? device.modules : []);
  return all
    .map(function (m, i) { return { m: m, i: i }; })
    .filter(function (x) { return x.m && TYPE_OF[x.m.type] && x.m._id; })
    .sort(function (a, b) { return (ORDER[a.m.type] - ORDER[b.m.type]) || (a.i - b.i); })
    .map(function (x) { return x.m; });
}

function moduleInstance(device, module, units, t) {
  var sep = decimalSeparator(units.locale);
  var type = TYPE_OF[module.type];
  var stationName = String(device.home_name || device.station_name || 'Netatmo').trim();
  var moduleName = String(module.module_name || '').trim() || t[type];
  var d = module.dashboard_data || {};
  var p = {};

  // A plain hyphen: watch fonts may lack the en dash.
  p.name = text(stationName + ' - ' + moduleName);
  p.station = text(stationName);
  p.module_type = { shortText: { text: type } };

  if (isNumber(d.Temperature)) p.temperature = temperatureReading(d.Temperature, units, sep);
  if (isNumber(d.max_temp)) p.high = temperatureReading(d.max_temp, units, sep);
  if (isNumber(d.min_temp)) p.low = temperatureReading(d.min_temp, units, sep);
  if (d.temp_trend) p.temperature_trend = trendReading(d.temp_trend, t);
  if (isNumber(d.Humidity)) p.humidity = reading(d.Humidity, '%', 0, sep, { min: 0, max: 100 });
  if (isNumber(d.CO2)) p.co2 = reading(d.CO2, 'ppm', 0, sep, { min: 0 });
  if (isNumber(d.Noise)) p.noise = reading(d.Noise, 'dB', 0, sep, { min: 0 });
  if (isNumber(d.Pressure)) p.pressure = pressureReading(d.Pressure, units, sep);
  if (d.pressure_trend) p.pressure_trend = trendReading(d.pressure_trend, t);
  if (isNumber(d.Rain)) p.rain = rainReading(d.Rain, units, sep);
  if (isNumber(d.sum_rain_1)) p.rain_1h = rainReading(d.sum_rain_1, units, sep);
  if (isNumber(d.sum_rain_24)) p.rain_today = rainReading(d.sum_rain_24, units, sep);
  if (isNumber(d.WindStrength)) p.wind_speed = windReading(d.WindStrength, units, sep);
  // Netatmo reports a negative angle when there is no wind.
  if (isNumber(d.WindAngle) && d.WindAngle >= 0) p.wind_direction = directionReading(d.WindAngle, t);
  if (isNumber(d.GustStrength)) p.gust_speed = windReading(d.GustStrength, units, sep);
  if (isNumber(d.GustAngle) && d.GustAngle >= 0) p.gust_direction = directionReading(d.GustAngle, t);
  // The base station is mains powered and has no battery.
  if (isNumber(module.battery_percent)) {
    p.battery = reading(module.battery_percent, '%', 0, sep, { min: 0, max: 100 });
  }

  var reachable = module.reachable !== false;
  p.reachable = { boolean: { value: reachable }, shortText: { text: reachable ? t.online : t.offline } };
  if (isNumber(d.time_utc)) {
    p.updated = { timestamp: { value: d.time_utc }, shortText: { text: clockText(d.time_utc, units.clock) } };
  }

  Object.keys(p).forEach(function (k) { if (!p[k]) delete p[k]; });
  return { instanceId: module._id, properties: p };
}

function buildInstances(body, units) {
  var t = texts(units.locale);
  var instances = [];
  var devices = body && Array.isArray(body.devices) ? body.devices : [];
  devices.forEach(function (device) {
    orderedModules(device).forEach(function (module) {
      instances.push(moduleInstance(device, module, units, t));
    });
  });
  return instances;
}

// ---------------------------------------------------------------- refresh interval

function intervalMinutes() {
  var n = Number(localStorage.getItem(INTERVAL_KEY));
  return INTERVALS.indexOf(n) >= 0 ? n : DEFAULT_INTERVAL;
}

function setIntervalMinutes(n) {
  n = Number(n);
  if (INTERVALS.indexOf(n) < 0) return false;
  localStorage.setItem(INTERVAL_KEY, String(n));
  return true;
}

/** When data fetched at `at` (ms) should be fetched again. */
function dueAt(at) {
  return at + intervalMinutes() * 60 * 1000;
}

// ---------------------------------------------------------------- tokens

async function secureItem(key) {
  return String((await Pebble.secureStorage.getItem(key)) || '').trim();
}

function accessToken() {
  return secureItem(TOKEN_KEY);
}

async function saveTokenBundle(bundle) {
  var token = String((bundle && bundle.access_token) || '').trim();
  if (!token) throw new Error('Netatmo returned no access token.');
  await Pebble.secureStorage.setItem(TOKEN_KEY, token);
  var brokerRefresh = String(bundle.broker_refresh || '').trim();
  // A refresh may not hand out a new broker token; keep the one we have then.
  if (brokerRefresh) await Pebble.secureStorage.setItem(BROKER_REFRESH_KEY, brokerRefresh);
  var expiresIn = Number(bundle.expires_in || 0);
  if (isFinite(expiresIn) && expiresIn > 0) {
    localStorage.setItem(EXPIRES_AT_KEY, String(Date.now() + expiresIn * 1000));
  } else {
    localStorage.removeItem(EXPIRES_AT_KEY);
  }
}

async function clearTokens() {
  await Pebble.secureStorage.removeItem(TOKEN_KEY);
  await Pebble.secureStorage.removeItem(BROKER_REFRESH_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(CACHE_KEY);
}

/** Exchanges the broker refresh token for a new access token; '' if there is none. */
async function refreshAccessToken() {
  var brokerRefresh = await secureItem(BROKER_REFRESH_KEY);
  if (!brokerRefresh) return '';
  await saveTokenBundle(await Pebble.oauth.refresh(CONNECTOR, brokerRefresh));
  return accessToken();
}

async function ensureAccessToken() {
  var token = await accessToken();
  var expiresAt = Number(localStorage.getItem(EXPIRES_AT_KEY) || 0);
  if (token && (!expiresAt || Date.now() < expiresAt - 60 * 1000)) return token;
  try {
    return (await refreshAccessToken()) || token;
  } catch (e) {
    console.log('Netatmo token refresh failed: ' + ((e && e.message) || e));
    return token;
  }
}

// ---------------------------------------------------------------- API

function ApiError(code, message, cause) {
  this.code = code;
  this.message = message;
  this.cause = cause;
}

async function getStationsData(token) {
  var response;
  try {
    response = await fetch(API_ROOT + '/getstationsdata?get_favorites=false', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
  } catch (e) {
    return { ok: false, status: 0, cause: e };
  }
  var json = null;
  try { json = JSON.parse(await response.text()); } catch (e) {}
  var errorCode = json && json.error && json.error.code;
  return {
    ok: response.status >= 200 && response.status < 300 && !!(json && json.body),
    status: response.status,
    json: json,
    errorCode: errorCode,
    tokenProblem: response.status === 401 ||
      (response.status === 403 && TOKEN_ERROR_CODES.indexOf(errorCode) >= 0),
  };
}

/**
 * { body, at }: Netatmo's getstationsdata body and when it was fetched (ms), from the cache
 * until the refresh interval is up. Throws ApiError with a plugin error code.
 */
async function loadData(options) {
  options = options || {};
  var now = Date.now();
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) {}
  if (cached && cached.body && now >= cached.at) {
    var fresh = now < dueAt(cached.at) - DUE_SLACK_MS;
    var tooSoon = now - cached.at < MIN_FETCH_GAP_MS;
    if (!options.force ? fresh : tooSoon) return cached;
  }

  var token = options.token || await ensureAccessToken();
  if (!token) throw new ApiError('AUTH_REQUIRED', 'notConnected');

  var result = await getStationsData(token);
  if (!result.ok && result.tokenProblem && !options.token) {
    var renewed = '';
    try { renewed = await refreshAccessToken(); } catch (e) {}
    if (renewed) result = await getStationsData(renewed);
  }

  if (!result.ok) {
    console.log('Netatmo getstationsdata failed: HTTP ' + result.status + ' ' +
      JSON.stringify(result.json && result.json.error));
    if (result.tokenProblem) throw new ApiError('AUTH_REQUIRED', 'authFailed');
    if (result.status === 429 || result.errorCode === RATE_LIMIT_CODE) {
      throw new ApiError('RATE_LIMITED', 'rateLimited');
    }
    // Network trouble: a recent reading beats none.
    var staleLimit = Math.max(STALE_FALLBACK_MS, intervalMinutes() * 60 * 1000 * 2);
    if (cached && cached.body && now - cached.at < staleLimit && !options.token) {
      return cached;
    }
    if (result.status === 0) throw new ApiError('PLUGIN_UNAVAILABLE', 'unreachable', result.cause);
    throw new ApiError('PLUGIN_UNAVAILABLE', 'unreachable');
  }

  var data = { at: now, body: result.json.body };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
  return data;
}

// ---------------------------------------------------------------- permissions

/** { host, sure } if api.netatmo.com isn't allowed (sure) or isn't reachable (not sure), else null. */
async function blockedHost() {
  var host = 'api.netatmo.com';
  if (typeof Pebble !== 'undefined' && Pebble.permissions) {
    return (await Pebble.permissions.query('Internet/' + host)) === 'granted' ? null : { host: host, sure: true };
  }
  try {
    await fetch('https://' + host + '/');
    return null;
  } catch (e) {
    return { host: host, sure: false };
  }
}

async function checkReach() {
  var blocked = await blockedHost();
  try {
    if (blocked) localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked));
    else localStorage.removeItem(BLOCKED_KEY);
  } catch (e) {}
  return blocked;
}

function errorMessage(error, t) {
  if (error && error.cause && error.cause.name === 'NotAllowedError') {
    return t === TEXTS.cs
      ? 'Plugin nemá povolení připojit se k api.netatmo.com. Zapněte ho v oprávněních pluginu.'
      : 'The plugin isn\'t allowed to connect to api.netatmo.com. Turn it on in the plugin\'s permissions.';
  }
  return (error && t[error.message]) || (error && error.message) || t.unreachable;
}

// ---------------------------------------------------------------- handlers

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category !== 'weather' || ITEMS.indexOf(request.item) < 0) {
    respond.error('INVALID_REQUEST', 'Unsupported source.');
    return;
  }
  // So this runs again when the user changes their units.
  Pebble.subscribeSource(UNITS);

  var data;
  try {
    data = await loadData();
  } catch (e) {
    var units0 = await userUnits(null);
    respond.error(e.code || 'UNKNOWN', errorMessage(e, texts(units0.locale)));
    return;
  }
  var body = data.body;
  var units = await userUnits(body.user && body.user.administrative);
  var instances = buildInstances(body, units);
  if (!instances.length) {
    respond.error('PLUGIN_UNAVAILABLE', texts(units.locale).noStations);
    return;
  }
  var validUntil = dueAt(data.at);
  if (validUntil < Date.now() + MIN_FETCH_GAP_MS) validUntil = Date.now() + MIN_FETCH_GAP_MS;
  respond.data({ validUntilMs: validUntil, instances: instances });
});

/** What the settings page shows: each module and its readings as long text. */
async function preview(body) {
  var units = await userUnits(body.user && body.user.administrative);
  return buildInstances(body, units).map(function (instance) {
    var p = instance.properties;
    var rows = [];
    Object.keys(p).forEach(function (key) {
      if (['name', 'station', 'module_type'].indexOf(key) >= 0) return;
      var v = p[key].longText || p[key].shortText;
      if (v) rows.push([key, v.text]);
    });
    return {
      id: instance.instanceId,
      name: p.name.shortText.text,
      station: p.station.shortText.text,
      type: p.module_type.shortText.text,
      reachable: p.reachable.boolean.value,
      rows: rows,
    };
  });
}

/** Settings the page shows whatever the state; `locale` is the language the readings are in. */
async function pageSettings(body) {
  var units = await userUnits(body && body.user && body.user.administrative);
  return {
    interval: intervalMinutes(),
    intervals: INTERVALS,
    locale: units.locale,
    localeFrom: units.localeFrom,
  };
}

async function statusReply(force, token) {
  var connected = (await accessToken()).length > 0 || !!token;
  if (!connected) return Object.assign({ connected: false }, await pageSettings(null));
  try {
    var data = await loadData({ force: force, token: token });
    return Object.assign({ connected: true, modules: await preview(data.body), fetchedAt: data.at }, await pageSettings(data.body));
  } catch (e) {
    var settings = await pageSettings(null);
    var units = { locale: settings.locale };
    return Object.assign({
      connected: e.code !== 'AUTH_REQUIRED',
      authRequired: e.code === 'AUTH_REQUIRED',
      error: errorMessage(e, texts(units.locale)),
    }, settings);
  }
}

Pebble.registerConfigHandler(async function (message, respond) {
  switch (message && message.type) {
    case 'reach':
      respond({ blocked: await checkReach().catch(function () { return null; }) });
      return;

    case 'status':
      respond(await statusReply(false));
      return;

    case 'refresh':
      respond(await statusReply(true));
      Pebble.refreshSources(SOURCES);
      return;

    case 'setInterval':
      if (!setIntervalMinutes(message.minutes)) {
        respond({ error: 'Unsupported interval.' });
        return;
      }
      // Subscribers get a validUntilMs for the new interval; the cached data is reused.
      Pebble.refreshSources(SOURCES);
      respond({ interval: intervalMinutes() });
      return;

    case 'connect': {
      var bundle;
      try {
        bundle = await Pebble.oauth.authorize(CONNECTOR);
      } catch (e) {
        respond({ connected: false, error: (e && e.message) || 'Sign-in failed.' });
        return;
      }
      var token = String((bundle && bundle.access_token) || '').trim();
      if (!token) {
        respond({ connected: false, error: 'Netatmo returned no access token.' });
        return;
      }
      // Check the new token works before keeping it.
      localStorage.removeItem(CACHE_KEY);
      var reply = await statusReply(true, token);
      if (!reply.modules) {
        respond({ connected: false, error: reply.error });
        return;
      }
      await saveTokenBundle(bundle);
      Pebble.refreshSources(SOURCES);
      respond(reply);
      return;
    }

    case 'unlink':
      await clearTokens();
      Pebble.refreshSources(SOURCES);
      respond(Object.assign({ connected: false }, await pageSettings(null)));
      return;

    default:
      respond({ error: 'Unknown message type.' });
  }
});
