# Netatmo Weather – Pebble plugin

A plugin (plugin-only `.pbw`, no watch code) for the Pebble mobile app 1.18+. It reads data
from Netatmo weather stations and makes it available to any watchface, app or Index as the
source `weather/netatmo`.

## What the plugin provides

The `weather/netatmo` source has one instance per module. The order is stable: for each
station, first the outdoor module, then the base station, extra indoor modules, the rain gauge
and the wind gauge. So `instances[0]` is the outdoor temperature of the first station.
`instanceId` is the module's MAC address. The instance name (`name`) has the form
"Station - Module", for example `Home - Outdoor`.

| Property | Shapes | Modules |
|---|---|---|
| `name`, `station` | shortText, longText | all |
| `module_type` | shortText: `outdoor` / `indoor` / `rain` / `wind` | all |
| `temperature`, `high`, `low` | shortText, longText, numericValue (°C/°F) | outdoor, indoor |
| `temperature_trend`, `pressure_trend` | shortText, longText | outdoor, indoor / base |
| `humidity` | … numericValue (%, 0–100) | outdoor, indoor |
| `co2` (ppm), `noise` (dB) | … numericValue | indoor / base |
| `pressure` | … numericValue (hPa/inHg) | base |
| `rain`, `rain_1h`, `rain_today` | … numericValue (mm/in) | rain gauge |
| `wind_speed`, `gust_speed` | … numericValue (km/h, m/s, mph, knots) | wind gauge |
| `wind_direction`, `gust_direction` | … numericValue (°, direction the wind blows from), shortText `SW` | wind gauge |
| `battery` | … numericValue (%) | battery-powered modules |
| `reachable` | boolean, shortText | all |
| `updated` | timestamp, shortText (time of measurement) | all |

Units, decimal separator, 12/24h format and language (English/Czech) follow
`preferences/units`. When it isn't available, the Netatmo account settings are used. A missing
property means the module isn't reporting it right now (for example when it's offline).

The refresh interval is chosen in the plugin settings: 15 minutes (default), 30 minutes,
1 hour or 6 hours. Netatmo is queried at most once per interval; in between, the plugin answers
from its cache and `validUntilMs` is the end of the interval. The **Refresh** button fetches
data right away. When the network is down, the plugin returns older data (up to an hour, or up
to two intervals for longer intervals).

### Using it in a watchface (PKJS)

```js
Pebble.subscribeToSource({
  category: 'weather',
  item: 'netatmo',
  properties: ['name', 'temperature', 'humidity', 'co2'],
  onData: function (e) {
    var outdoor = e.instances[0] && e.instances[0].properties;
    var temp = outdoor && outdoor.temperature ? outdoor.temperature.shortText.text : '--';
    // ... send to the watch via AppMessage
  },
  onError: function (err) { console.log(err.code + ' ' + err.message); },
});
```

The watchface needs `usesPermissions` in its `package.json` (manifestVersion 2), otherwise it
can't see plugins.

## Setting up sign-in (OAuth)

Token exchange is handled by the Pebble appstore broker, so the client secret is not in the
`.pbw`. These steps are needed only once:

1. Create an app at <https://dev.netatmo.com/apps>. Set its **Redirect URI** to
   `https://appstore-api.repebble.com/api/oauth/broker/callback`.
2. Run `pebble login`, then `pebble publish`. The first publish creates the listing and offers
   to set up the connector. Or set it up by hand:

   ```sh
   pebble oauth-connector set --slug netatmo \
     --provider-label Netatmo \
     --authorize-url https://api.netatmo.com/oauth2/authorize \
     --token-url https://api.netatmo.com/oauth2/token \
     --scopes read_station \
     --token-auth-style body --token-request-format form \
     --client-id <CLIENT_ID>
   # prompts for the secret (or use PEBBLE_OAUTH_CLIENT_SECRET / --client-secret-file)
   ```

3. In the Pebble app, turn on Settings → Plugins → *Plugins / permissions preview*. Install the
   plugin and tap **Sign in with Netatmo** in its settings.

## Development

Building needs pebble-tool 5.1+ and SDK 4.44+ (`pebble sdk activate 4.44`).

```sh
npm test                 # tests against a simulated Pebble runtime (node --test)
pebble build             # -> build/Netatmoplugin.pbw
pebble install --phone <IP>
pebble logs              # console.log output from the plugin
```

| File | Contents |
|---|---|
| `package.json` | manifest: permissions, the `weather/netatmo` source, the `netatmo` OAuth connector |
| `src/plugin/index.js` | the plugin: tokens, `getstationsdata` calls, cache, conversion to instances |
| `src/config.html` | settings page: sign in, sign out, module preview |
| `test/plugin.test.cjs` | tests |

## License

MIT, see [LICENSE](LICENSE).
