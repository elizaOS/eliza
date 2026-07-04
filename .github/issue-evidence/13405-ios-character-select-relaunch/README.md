# Issue #13405 iOS cold-relaunch proof

Date: 2026-07-04

Build under test:
- Repository commit: `9fa588f26cf17757f5252d35fbba26aefe635ed7`
- Renderer build: see `renderer-build.json`
- App bundle: `ai.elizaos.app`, version `1.0` build `1`
- Built app path: `/Users/shawwalters/Library/Developer/Xcode/DerivedData/App-cxkmijzlfyvpshcwbpdohrghqmuk/Build/Products/Debug-iphonesimulator/App.app`
- Simulator: iPhone 16 Pro, UDID `F165C3A3-5069-4174-A40C-89F0BCC4B9FB`, iOS 18.1

Commands run:
- `bun run --cwd packages/ui test src/state/startup-phase-hydrate.character-select.test.ts src/state/first-run-completion-persist.test.tsx`
- `bun run --cwd packages/app audit:app`
- `bun run --cwd packages/app build:ios:local:sim`
- `ELIZA_API_PORT=31338 ELIZA_PAIRING_DISABLED=1 node packages/app-core/scripts/run-node-tsx.mjs packages/app-core/scripts/serve-real-local-agent.ts`
- `node packages/app/scripts/ios-onboarding-smoke.mjs --api-base http://127.0.0.1:31338`

Result:
- Fresh install completed first-run remote onboarding and reached home/chat.
- The smoke then terminated `ai.elizaos.app`, relaunched it cold, and verified home/chat again.
- `result.json` reports `coldRelaunch.homeVisible: true`, `coldRelaunch.composerVisible: true`, `coldRelaunch.onboardingHidden: true`, and durable `coldRelaunch.storage["eliza:first-run-complete"]: "1"`.
- Visual review of `cold-relaunch-home.png` shows the normal home/chat surface, not Character Select.

Artifacts:
- `onboarding-to-home.mp4` - full simulator recording from fresh launch through cold relaunch.
- `fresh-onboarding.png` - initial fresh launch capture.
- `home-landing.png` - post-onboarding home/chat capture.
- `cold-relaunch-home.png` - cold-relaunch home/chat capture.
- `result.json` - structured in-app proof from Capacitor Preferences.
- `ios-onboarding-smoke.log` - harness command log.
- `host-agent.log` - deterministic host agent log.
- `simulator-app.log` - native simulator log stream for process `App`.
- `app-info.plist.txt` - app bundle identity/version metadata.
- `simulator.txt` - booted simulator metadata.
