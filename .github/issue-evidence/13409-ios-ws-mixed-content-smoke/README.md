# Issue #13409 — iOS simulator mixed-content smoke proof

Date: 2026-07-04

## Result

PASS. The iOS simulator remote-host lane was rebuilt, reinstalled, and run from
an HTTPS localhost WebView origin against a healthy HTTP loopback agent backend.

Structured proof is in `result.json`:

- `mixedContent.webViewOrigin`: `https://localhost:41443`
- `mixedContent.apiBase`: `http://127.0.0.1:31338`
- `mixedContent.expectedInsecureWebSocketUrl`: `ws://127.0.0.1:31338/ws`
- `mixedContent.mixedContentWouldBlockWebSocket`: `true`
- `mixedContent.webSocketConstructorCalls`: `[]`
- `mixedContent.connectionState.state`: `connected`
- `mixedContent.restHealth.status`: `200`
- `mixedContent.lostBackendOverlayAbsent`: `true`

The same run also reached the home/chat surface and passed the cold relaunch
check with the remote active-server still restored.

## Commands

Host agent:

```sh
ELIZA_API_PORT=31338 ELIZA_PAIRING_DISABLED=1 node packages/app-core/scripts/run-node-tsx.mjs packages/app-core/scripts/serve-real-local-agent.ts
```

HTTPS renderer origin for the simulator lane:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
  -subj '/CN=localhost' \
  -keyout /tmp/eliza-13409-https/localhost.key \
  -out /tmp/eliza-13409-https/localhost.crt \
  -extensions v3_req -config <generated localhost SAN config>
xcrun simctl keychain F165C3A3-5069-4174-A40C-89F0BCC4B9FB add-root-cert /tmp/eliza-13409-https/localhost.crt
ELIZA_CAPACITOR_SERVER_URL=https://localhost:41443 bun run --cwd packages/app build:ios:local:sim
node <https static server for packages/app/dist on 127.0.0.1:41443>
node packages/app/scripts/ios-onboarding-smoke.mjs --api-base http://127.0.0.1:31338
```

## Artifacts

- `onboarding-to-home.mp4` — full simulator recording.
- `fresh-onboarding.png`, `home-landing.png`, `cold-relaunch-home.png` —
  screenshots before connection, after connection, and after cold relaunch.
- `result.json` — structured in-app frontend/network proof.
- `ios-onboarding-smoke.log` — simulator harness log showing reinstall, launch,
  screenshots, video, and PASS.
- `simulator-app.log` — native log slice for the final HTTPS-origin run.
- `host-agent.log` — host API log showing `http://127.0.0.1:31338` healthy.
- `https-renderer-server.log` — HTTPS static renderer server log.
- `capacitor.config.json` — generated app config with
  `server.url=https://localhost:41443`.
- `build-and-environment.txt` — simulator/iOS/macOS/Xcode/build/cert metadata and
  artifact hashes.

## Notes

The ordinary bundled-assets iOS simulator build runs from
`capacitor://localhost` because Capacitor 8 rejects `server.iosScheme=https` for
asset-handler schemes. That lane is not the #13372/#13409 mixed-content setup,
so this proof uses an explicit non-store simulator `server.url` pointing at a
trusted HTTPS localhost renderer. The first bundled-assets diagnostic correctly
failed the new probe with `webViewOrigin=capacitor://localhost`, proving the
harness does not accept a false positive.
