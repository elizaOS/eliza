# iOS simulator boot proof — #11030 fix branch

Captured 2026-07-01 on `fix/11030-ios-device-boot-hang` (all three legs applied),
iPhone 16 simulator (iOS 18.1, udid `39F890C2-072D-4BFE-9144-5327AF30B10A`).

Build: `bun run --cwd packages/app build:ios:local:sim` (after
`bun run --cwd packages/agent build:ios-bun` — the lane's stale-agent-bundle
gate correctly refused the fresh worktree's missing artifact first).
`** BUILD SUCCEEDED **` — this is a full Xcode compile of the **patched**
`@capacitor/ios` pod (the Podfile consumes it as a development pod straight
from node_modules, so the cold-launch eval guard compiled for real, upgrading
leg C's `swiftc -parse` validation to a full-compile proof).

## Anti-stale gate exercised for real

First smoke run refused to proceed:

```
[local-chat-smoke] installed renderer buildId 4b760801… != freshly built 7259ce27… — the simulator is running STALE UI.
```

After `simctl install` of the fresh App.app:

```
[local-chat-smoke] renderer build stamp OK: installed == fresh (7259ce27c387 built 2026-07-02T02:27:32.846Z).
Test Files  2 passed (2) · Tests  10 passed (10)
```

## Clean-boot console (`sim-boot-console.log`)

The exact window where the real device showed the bug is clean:

```
⚡️  Loading app at capacitor://localhost...
Reachable via WiFi
⚡️  WebView loaded
⚡️  [info] - [renderer-build] 7259ce27c387 built 2026-07-02T02:27:32.846Z (variant=direct, target=ios)
```

`grep -c "JS Eval error" sim-boot-console.log` → **0**. On the pre-fix device
logs the `⚡️ JS Eval error A JavaScript exception occurred` line sat exactly
between `Reachable via WiFi` and `WebView loaded` on every boot.

## Screenshots (hand-reviewed)

- `sim-boot-home-clean.png` — fresh launch after a simulator reboot: the full
  home screen renders (clock + greeting, welcome chips, Connect-calendar
  affordance, composer with mic). **No "Booting up…" splash, no hang.**
  Verdict: good.
- `sim-boot-home.png` — earlier capture from the smoke's deep-link launch;
  identical home underneath a SpringBoard "Open in Eliza?" alert that the
  smoke's URL-scheme launch leaves behind (not a product surface). Kept for
  completeness. Verdict: good (alert is harness-origin).

Real-device (MoonCycles) capture: see `device-boot-README.md` in this
directory (separate capture pass).
