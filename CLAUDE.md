# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A plugin-only Pebble `.pbw` (`"projectType": "plugin"`, no watch C code) for the Pebble mobile app's plugin system (app 1.18+, guide: https://developer.repebble.com/guides/plugins/preview/). It runs as JavaScript on the phone, reads the user's Netatmo weather stations and serves them to any watchface/app as the source `weather/netatmo`. README.md (Czech) documents the source's properties and the OAuth setup.

## Commands

```sh
npm test                                              # node --test test/ (Node 18)
node --test --test-name-pattern "rate limit" test/    # single test
pebble build                                          # -> build/Netatmoplugin.pbw
pebble publish --pbw build/Netatmoplugin.pbw --non-interactive --release-notes "..."
pebble logs --phone <IP>                              # plugin console.log (Dev Connection on)
```

- Building plugins needs pebble-tool 5.1+ and SDK 4.44+ active (`pebble sdk activate 4.44`); older SDKs can't build `projectType: plugin`.
- `pebble login` runs in WSL without a browser: use `BROWSER=explorer.exe pebble login`, or open the printed URL in Windows.
- The plugin is published as an unlisted store app (id `a42fec77216e434ea54a40a2`). The user installs from the store, so testing a change means bumping the version and publishing. Bump only the patch number for debugging releases. 1.1.4 was published and then deleted, so don't reuse it.
- Git repo (branch `main`, private GitHub). Helper files (logos, `src/icon.svg`, `projekt.md`) are deliberately untracked via `.gitignore`.

## Architecture

- `package.json` → `pebble` block is the manifest: `usesPermissions` (Internet `api.netatmo.com` only), `plugin.sources` (one source, `weather/netatmo`, properties and their shapes), `plugin.oauth.netatmo` (connector slug), `configPage`. The host drops any property/shape the manifest doesn't declare, so a new property has to be added there as well as in code.
- `src/plugin/index.js` is the whole plugin. It is started fresh for every request, so **no state lives in variables**: tokens in `Pebble.secureStorage`, everything else (cached API body, token expiry, refresh interval) in `localStorage` under `netatmo.*` keys.
  - Source handler: `loadData()` (cache or `GET /api/getstationsdata`) → `buildInstances()` → one instance per module, ordered per station outdoor (NAModule1), base (NAMain), extra indoor (NAModule4), rain (NAModule3), wind (NAModule2). `instanceId` = module MAC, `name` = "Station - Module". Complication slots refer to instances by index, so this order must stay stable.
  - The handler also answers the old item `weather/station` (pre-1.1.0), and `refreshSources` refreshes both.
  - Netatmo values are always metric (°C, mbar, mm, km/h). They are converted to the user's units from `preferences/units` (read via `Pebble.readSource` and re-subscribed on every run), with Netatmo account settings as the fallback.
  - Text: `TEXTS` has `en` and `cs` only. Any other locale gets English words plus its own decimal separator. shortText must stay ≤ 7 characters (except `name`/`station`), and the tests check this.
  - Auth: `Pebble.oauth.authorize/refresh('netatmo')` through the appstore broker (the secret lives in the store connector, never in the pbw). A 401, or a 403 with Netatmo error code 2/3, triggers one broker refresh and a retry. Code 26 or HTTP 429 → `RATE_LIMITED`.
  - Refresh interval (15/30/60/360 min, settings page) decides cache freshness and `validUntilMs`. `suggestedRefreshIntervalSec` is 900, and `DUE_SLACK_MS` keeps host jitter from pushing a fetch back by a whole host cycle.
  - Config handler messages: `reach`, `status`, `refresh`, `connect`, `unlink`, `setInterval`.
- `src/config.html` is the bundled settings page. It talks to the plugin only via `Pebble.sendMessage('plugin', …)` after the `ready` event, can load nothing from outside declared domains (everything is inline), and switches its UI language to the `locale` the plugin reports so labels match the readings.
- `test/plugin.test.cjs` runs `index.js` in a `vm` context with a fake `Pebble`/`fetch`/`localStorage` (`host()` options: `secure`, `local`, `units`, `noUnits`, `body`, `validToken`, `fetch`). Results cross the vm realm, so they go through `plain()` (JSON round-trip) before `deepEqual`.

## Platform behaviour learned the hard way

- **Locale** in `preferences/units` is the language the watch reports when it connects (`watchInfo.language`, i.e. its language pack), else the phone's. After the watch language changes, the watch has to be disconnected and reconnected before plugins see it.
- **Store manifest:** the Pebble app uses the plugin manifest served by the store, not the one in the pbw. After a release the store kept serving the previous release's `plugin` block for a while, so check `https://appstore-api.repebble.com/api/v1/apps/id/a42fec77216e434ea54a40a2` → `plugin` before assuming a manifest change is live.
- The store returns `properties` keys sorted by length, and the app's complication picker shows them in that order. The manifest order can't change it.
