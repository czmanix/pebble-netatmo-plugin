# Netatmo Weather – Pebble plugin

Plugin (plugin-only `.pbw`, bez kódu pro hodinky) pro mobilní aplikaci Pebble 1.18+. Čte data
z meteostanic Netatmo a nabízí je libovolnému ciferníku, aplikaci i Indexu jako zdroj
`weather/netatmo`.

## Co plugin nabízí

Zdroj `weather/netatmo` obsahuje jednu instanci na každý modul. Pořadí je stabilní: u každé
stanice nejdřív venkovní modul, pak základna, další vnitřní moduly, srážkoměr a anemometr.
`instances[0]` je tedy venkovní teplota první stanice. `instanceId` je MAC adresa modulu.
Název instance (`name`) má tvar „Stanice - Modul“, například `Domov - venku`.

| Vlastnost | Tvary | Moduly |
|---|---|---|
| `name`, `station` | shortText, longText | všechny |
| `module_type` | shortText: `outdoor` / `indoor` / `rain` / `wind` | všechny |
| `temperature`, `high`, `low` | shortText, longText, numericValue (°C/°F) | venkovní, vnitřní |
| `temperature_trend`, `pressure_trend` | shortText, longText | venkovní, vnitřní / základna |
| `humidity` | … numericValue (%, 0–100) | venkovní, vnitřní |
| `co2` (ppm), `noise` (dB) | … numericValue | vnitřní / základna |
| `pressure` | … numericValue (hPa/inHg) | základna |
| `rain`, `rain_1h`, `rain_today` | … numericValue (mm/in) | srážkoměr |
| `wind_speed`, `gust_speed` | … numericValue (km/h, m/s, mph, knots) | anemometr |
| `wind_direction`, `gust_direction` | … numericValue (°, odkud fouká), shortText `JZ`/`SW` | anemometr |
| `battery` | … numericValue (%) | moduly na baterie |
| `reachable` | boolean, shortText | všechny |
| `updated` | timestamp, shortText (čas měření) | všechny |

Jednotky, desetinný oddělovač, 12/24h formát a jazyk (čeština/angličtina) se řídí podle
`preferences/units`. Když není k dispozici, použije se nastavení účtu Netatmo. Chybějící
vlastnost znamená, že ji modul právě nehlásí (například když je offline).

Interval aktualizace se volí v nastavení pluginu: 15 minut (výchozí), 30 minut, 1 hodina nebo
6 hodin. Netatmo se dotazuje nejvýš jednou za interval, mezi tím plugin odpovídá z cache
a `validUntilMs` je konec intervalu. Tlačítko **Obnovit** stáhne data hned. Při výpadku sítě
plugin vrátí starší data (až hodinu, u delších intervalů až dva intervaly).

### Použití v ciferníku (PKJS)

```js
Pebble.subscribeToSource({
  category: 'weather',
  item: 'netatmo',
  properties: ['name', 'temperature', 'humidity', 'co2'],
  onData: function (e) {
    var outdoor = e.instances[0] && e.instances[0].properties;
    var temp = outdoor && outdoor.temperature ? outdoor.temperature.shortText.text : '--';
    // ... poslat do hodinek přes AppMessage
  },
  onError: function (err) { console.log(err.code + ' ' + err.message); },
});
```

Ciferník musí mít v `package.json` `usesPermissions` (manifestVersion 2), jinak pluginy nevidí.

## Zprovoznění přihlášení (OAuth)

Výměnu tokenů dělá broker Pebble appstore, takže client secret v `.pbw` není. Kroky jsou
potřeba jen jednou:

1. Na <https://dev.netatmo.com/apps> si založ aplikaci. Do **Redirect URI** zadej
   `https://appstore-api.repebble.com/api/oauth/broker/callback`.
2. `pebble login`, pak `pebble publish`. První publikace založí listing a nabídne nastavení
   konektoru. Případně ho nastav ručně:

   ```sh
   pebble oauth-connector set --slug netatmo \
     --provider-label Netatmo \
     --authorize-url https://api.netatmo.com/oauth2/authorize \
     --token-url https://api.netatmo.com/oauth2/token \
     --scopes read_station \
     --token-auth-style body --token-request-format form \
     --client-id <CLIENT_ID>
   # secret se zeptá interaktivně (nebo PEBBLE_OAUTH_CLIENT_SECRET / --client-secret-file)
   ```

3. V aplikaci Pebble zapni Settings → Plugins → *Plugins / permissions preview*. Nainstaluj
   plugin a v jeho nastavení klikni na **Přihlásit se k Netatmo**.

## Vývoj

Build potřebuje pebble-tool 5.1+ a SDK 4.44+ (`pebble sdk activate 4.44`).

```sh
npm test                 # testy proti simulovanému Pebble runtime (node --test)
pebble build             # -> build/Netatmoplugin.pbw
pebble install --phone <IP>
pebble logs              # console.log z pluginu
```

| Soubor | Obsah |
|---|---|
| `package.json` | manifest: oprávnění, zdroj `weather/netatmo`, OAuth konektor `netatmo` |
| `src/plugin/index.js` | plugin: tokeny, volání `getstationsdata`, cache, převod na instance |
| `src/config.html` | stránka nastavení: přihlášení, odhlášení, náhled modulů |
| `test/plugin.test.cjs` | testy |
