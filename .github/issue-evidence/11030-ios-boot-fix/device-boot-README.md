# #11030 — REAL-DEVICE boot verification (MoonCycles, iPhone 16 Pro Max, iOS 18.7.8)

Physical-device proof that the #11030 boot-hang fixes work on real hardware.
Worktree: `.claude/worktrees/eliza-11030`, branch `fix/11030-ios-device-boot-hang`,
HEAD `e38516e053901a6593e0553838807f2871cef204` (all three legs: A `5fb0cff3766`,
B `245ae9231c9`, C `e38516e0539`).

Device: **MoonCycles** — iPhone 16 Pro Max (iPhone17,2), iOS 18.7.8,
devicectl identifier `59EBB356-BC44-5AA2-91F1-E6AAE756BB86`,
UDID `00008140-0006491E2E90801C`, developer mode enabled, `available (paired)`.

## Verdict

| # | Required proof | Result |
|---|---|---|
| 1 | NO `⚡️ JS Eval error` between `Loading app at capacitor://localhost...` and `WebView loaded` | **PASS — 0 occurrences in the entire 100 s capture** (was deterministic pre-fix) |
| 2 | Renderer stamp matches the FRESH build (`variant=direct, target=ios`) | **PASS — `7259ce27c387` = fresh dist buildId, commit `e38516e` (worktree HEAD)** |
| 3 | Native agent reaches `state:"running"`; renderer proceeds past boot | **PASS — `TO JS {...,"state":"running"}` + Preferences reads answered, `Agent getStatus` answered, listeners registered, BackgroundRunner configured; no error state, no crash/retry loop for the rest of the 100 s** |

Raw log: [`device-boot-console.log`](device-boot-console.log) (87 lines; the final
`App terminated due to signal 15` is our own capture-window kill after 100 s, not a crash).

## The exact console lines (quoted from `device-boot-console.log`)

Boot window — line numbers from the raw log:

```
12: ⚡️  Loading app at capacitor://localhost...
13: Reachable via WiFi
14: ⚡️  [info] - [renderer-build] 7259ce27c387 built 2026-07-02T02:27:32.846Z (variant=direct, target=ios)
15: ⚡️  WebView loaded
16: ⚡️  [info] - [shell] window shell mode: main (search="")
```

→ **No `JS Eval error` line between 12 and 15 — or anywhere else** (`grep -c 'JS Eval error'` = 0).

Agent running + renderer proceeding past boot:

```
79: ⚡️  To Native ->  Agent getStatus 106647054
82: ⚡️  TO JS {"startedAt":1782960083166.0911,"agentName":"Eliza","error":null,"port":null,"state":"running"}
84: ⚡️  To Native ->  CapacitorBackgroundRunner dispatchEvent 106647056
85: ⚡️  TO JS {"event":"configure","configured":true}
86: ⚡️  TO JS {"isActive":true}
```

Plus ~22 `Preferences get` round-trips (lines 17–59, all answered), Keyboard/StatusBar
configuration, and `App`/`Network` listener registration — the renderer is live and
executing its normal startup sequence, not stuck on the splash.

## Before → after contrast (same physical device)

Pre-fix captures from the prior session
(`.github/issue-evidence/10726-voice-delarp/ios-sim/`):

`ios-device-agent-running-console.log` — pre-fix **local** build `f7a99d1680ad`
(commit `e9aca0f1`), agent reached running but the UI hung on "Booting up…" at 150 s:

```
12: ⚡️  Loading app at capacitor://localhost...
14: ⚡️  JS Eval error A JavaScript exception occurred      ← deterministic, pre-fix
15: ⚡️  WebView loaded
16: ⚡️  [info] - [renderer-build] f7a99d1680ad built 2026-07-01T22:22:02.935Z (variant=direct, target=ios)
```

`ios-device-console.log` — pre-fix **store/cloud** build `a52440f57497`: same
`JS Eval error` at the same spot, agent went to `state:"error"` (no endpoint).

After-fix capture (this run, build `7259ce27c387`): **zero** `JS Eval error` lines.
That eval error was the compiled Capacitor bridge firing its cordova-compat
`resume`/`pause` evals before the WebView had a page — exactly what leg C
(`e38516e0539`, the patched `@capacitor/ios` pod gating those evals on webview load
state) removes. The patched pod was compiled into this device binary from the
worktree's `node_modules/@capacitor/ios` by CocoaPods.

### Bonus (leg A context) — stale persisted "cloud" value present, boot proceeds anyway

The device still holds prior-QA persisted state; the capture shows a persisted
`cloud` preference being read (line 41 `⚡️ TO JS {"value":"cloud"}` — the same
read appears at line 44 of the pre-fix log) and a gracefully-degraded warn:

```
60: ⚡️  [warn] - ... [persistence] failed to fetch server favorite apps: iOS cloud builds cannot use local-agent IPC unless local runtime mode is active
```

Pre-fix, this same persisted state accompanied an eternal splash; post-fix the boot
completes. Honest note: the `[StartupModeReconcile]` warn itself did **not** appear
in this capture — consistent with the reconciler's by-design no-op when the
persisted cloud mode is still usable (stored session / active-server record,
`packages/ui/src/first-run/reconcile-mobile-runtime-mode.ts`), or with the
`"cloud"` value belonging to a different Preferences key (the console shows call
ids, not key names). The required proofs (1)–(3) do not depend on it.

## How this build was produced, signed, installed, launched (exact commands)

### 1. Unsigned device build from the worktree (BUILD SUCCEEDED)

```bash
cd .claude/worktrees/eliza-11030/packages/app
env ELIZA_IOS_FULL_BUN_ENGINE=1 \
    ELIZA_IOS_BUILD_DESTINATION='generic/platform=iOS' \
    ELIZA_IOS_BUILD_SDK=iphoneos \
    ELIZA_IOS_DERIVED_DATA_PATH=<scratch>/dd-device-11030 \
    node ../../packages/app-core/scripts/run-mobile-build.mjs ios-local
# → ** BUILD SUCCEEDED **   (CODE_SIGNING_ALLOWED left unset → NO; this is what
#   sidesteps the "requires a development team" / "No Accounts" failures that
#   killed the signed-build attempts A and B)
```

The script auto-skipped the web rebuild — `existing dist is up-to-date
(buildId=7259ce27c387)` — dist was already built from this exact commit
(`e38516e`) during the sim lane, and the lane-stamp guard (leg B) verified it
matches `variant=direct / target=ios / runtimeMode=local` before cap-sync.
Confirmed in-bundle: `App.app/public/eliza-renderer-build.json` has
`buildId 7259ce27c387… / commit e38516e / variant direct / runtimeMode local`,
and `Frameworks/ElizaBunEngine.framework` is embedded.

### 2. Sign (graft profiles from the prior proven install, sign inner → outer)

Identity: `Apple Development: Shaw Walters (UT5K5Q5EVF)` hash
`96A036FCADC6BCD189190DD30D8AA4988C6F76B8` — its cert **OU is actually team
`25877RY2EH`** (the CN parenthetical is misleading), which matches the profile.

Profiles grafted from the prior successfully-installed build at
`~/Library/Developer/Xcode/DerivedData/App-dcwjcczvodmbpnaugudgfifljfjx/Build/Products/Debug-iphoneos/App.app`:
- app: `iOS Team Provisioning Profile: ai.elizaos.app` (team `25877RY2EH`,
  expires 2027-06-22, `get-task-allow=true`, MoonCycles UDID
  `00008140-0006491E2E90801C` in `ProvisionedDevices`, embeds cert `96A036FC…`)
  → `App.app/embedded.mobileprovision`
- each `PlugIns/<Name>.appex`: its own per-extension profile + entitlements
  copied from the prior install's matching appex (so **no extensions were
  removed** — the whole bundle is provisioned).

```bash
IDENT=96A036FCADC6BCD189190DD30D8AA4988C6F76B8
# entitlements extracted from the prior signed app/appexes:
#   codesign -d --entitlements :- <prior App.app|.appex>  > ent-*.plist
cp <prior>/embedded.mobileprovision App.app/embedded.mobileprovision
for n in DeviceActivityMonitorExtension DeviceActivityReportExtension WebsiteBlockerContentExtension; do
  cp <prior>/PlugIns/$n.appex/embedded.mobileprovision App.app/PlugIns/$n.appex/
done
for f in App.app/Frameworks/*.framework; do codesign --force --sign $IDENT --timestamp=none "$f"; done
for d in App.app/*.dylib App.app/PlugIns/*.appex/*.dylib; do codesign --force --sign $IDENT --timestamp=none "$d"; done   # incl. the debug/__preview dylibs — deep-verify does NOT catch these
for n in <the 3 extensions>; do codesign --force --sign $IDENT --timestamp=none --entitlements ent-$n.plist App.app/PlugIns/$n.appex; done
codesign --force --sign $IDENT --timestamp=none --entitlements app-entitlements.plist App.app
codesign --verify --deep --strict App.app   # → valid on disk / satisfies its Designated Requirement
```

### 3. Install + launch with console (device was unlocked — no human step needed)

```bash
xcrun devicectl device install app --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 <stage>/App.app
# → App installed: bundleID ai.elizaos.app

xcrun devicectl device process launch --terminate-existing --console \
  --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 ai.elizaos.app > device-boot-console.log 2>&1
# captured 100 s, then killed the attached console (→ the trailing "signal 15" line)
```

Re-run command (if anyone wants to reproduce the capture — phone must be unlocked):

```bash
xcrun devicectl device process launch --terminate-existing --console \
  --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 ai.elizaos.app
```

## Follow-up launches — un-hangable splash proven in pixels; XCUITest-lane agent 503 observed honestly

The XCUITest screenshot harness (below) relaunches the app. On both
harness-driven launches (#2 and #4 in the table below) the native agent came
up in an error state — and the renderer did exactly what
leg A built: instead of the pre-fix eternal "Booting up…", the splash
**terminated at 92 s into a real, accessible, retryable error surface**
(`device-boot-screenshot-04-120s.png` / `-05-150s.png`):

```
Startup failed: Backend Timeout
Startup could not reach the agent after 92s of consecutive failures.
Last failure: /api/auth/status - HTTP 503 - Agent is in an error state. [Retry startup] [Report a Bug]
```

The exported AX hierarchy confirms live `StaticText`s + a focusable
`Retry startup` `Button` — an interactive UI, not a dead splash. This is the
bounded-boot machinery from leg A (`5fb0cff3766`: "polling-backend now
terminates — a terminal native agent error … dispatches AGENT_ERROR with the
REAL message into the existing error surface") running on real hardware.
Pre-fix, this exact device sat on "Booting up…" at 150 s **with the agent
running** (`ios-device-live-0*.png`).

**The pattern across four launches (honest accounting):**

| # | Launched via | Agent | Renderer |
|---|---|---|---|
| 1 | `devicectl … launch --console` | `state:"running"` | boots normally (`device-boot-console.log`) |
| 2 | XCUITest runner | error (503 at transport) | **leg-A error card at 92 s — no hang** |
| 3 | `devicectl … launch --console` | `state:"running"` | boots normally (`device-boot-console-relaunch.log`) |
| 4 | XCUITest runner (re-run) | error (503 at transport) | **leg-A error card at 96 s — no hang** (`device-boot-screenshot-2-150s.png`) |

Launch #3 (120 s console capture) on the same install:

```
⚡️  Loading app at capacitor://localhost...
⚡️  WebView loaded
⚡️  [info] - [renderer-build] 7259ce27c387 built 2026-07-02T02:27:32.846Z (variant=direct, target=ios)
...
⚡️  TO JS {"port":null,"error":null,"agentName":"Eliza","startedAt":1782960624650.667,"state":"running"}
```

Zero `JS Eval error` (grep = 0) and the same persisted `{"value":"cloud"}` read
(line 43) — boot completed anyway.

So the agent 503 is **specific to boots launched by the UI-testing runner**
(2/2), and never occurred on direct launches (2/2). No console can be attached
to an XCUITest-owned process with this tooling, so the agent-side error detail
for those boots is unavailable here. This is a separate boot-robustness
observation about the in-process Bun agent under the XCUITest environment —
worth its own follow-up issue — and not a #11030 regression: the #11030 symptom
was the *renderer* hanging on "Booting up…" forever, and in **every** post-fix
launch the renderer either reached the app (console proof, launches 1/3) or
terminated the splash into the real, retryable error surface (pixel proof,
launches 2/4). Pre-fix, the same XCUITest harness on the same phone produced
six screenshots of an eternal splash *while the agent was `state:"running"`*.

## Screenshots (XCUITest harness)

Reused the prior session's signed `AppUITests-Runner.app` + `AppUITests.xctest`
(`VoiceUITests`) from DerivedData with a hand-written `.xctestrun`
(`TestHostPath` = that runner, `UITargetAppPath` = this freshly signed
`App.app`), run via:

```bash
xcodebuild test-without-building -xctestrun device-shots.xctestrun \
  -destination 'platform=iOS,id=00008140-0006491E2E90801C' -resultBundlePath out.xcresult
xcrun xcresulttool export attachments --path out.xcresult --output-path <dir>
```

(The test case itself "fails" at the voice-composer typing step — it predates
this UI state — but the periodic `XCUIScreen` screenshots attach regardless.
Exit 65 is the assertion failure, not a harness malfunction.)

- `device-boot-screenshot-01-30s.png` … `-03-90s.png` — launch #2 boot progression.
- `device-boot-screenshot-04-120s.png`, `-05-150s.png` — the leg-A error card
  (see above): splash terminated, `Retry startup` present.
- `device-boot-screenshot-06-composer-focused.png` — final state of launch #2.
- `device-boot-screenshot-2-150s.png` — launch #4 (second harness pass): the
  same leg-A error card at 96 s, establishing the XCUITest-lane pattern above.

All screenshots were opened and reviewed by hand (verdicts inline above); the
on-device **home screen** pixels for a healthy boot exist for the simulator lane
(`sim-boot-home-clean.png`); on the physical phone the healthy boots (1/3) are
proven by console (agent `running`, renderer active) because the screenshot
harness itself perturbs the agent (the pattern in the table).

## Evidence files

- `device-boot-console.log` — full 100 s real-device boot console, launch #1 (raw).
- `device-boot-console-relaunch.log` — 120 s console, launch #3 (recovery proof).
- `device-boot-screenshot-*.png` — real-device pixels via on-device XCUITest.
- `device-boot-README.md` — this file.
- `sim-boot-console.log`, `sim-boot-home*.png`, `js-eval-error-analysis.md`,
  `sim-boot-README.md` — the (already-green) simulator lane.
