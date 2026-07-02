# #10936 — native attachment share/save + binary round-trip evidence

Carved out of #8876 closeout. Branch `feat/ui-mobile-gap-burndown`
(develop `5471346e7a6` + wave commits). Evidence tree swept for `csk-` / `sk-` /
`Bearer` — no real secrets (the only `sk-` hit is the `ask-to-nav` step name).

## What is PROVEN

### 1. Byte-exact binary round-trip through the real native WebView transport (Android)

`10936-binary-roundtrip-proof.json` — a PNG uploaded and re-served through the
installed Android app's WebView transport against the agent API, driven via
CDP-over-adb **inside the real app context** (ai.elizaos.app debug on
emulator-5556 / Android 14 x86_64):

- `uploadedSha256 == servedSha256 == c414cd0e204d…7ce77`, `byteExact: true`,
  70 bytes in / 70 bytes served.
- The content-addressed URL **is** the uploaded sha256
  (`/api/media/c414…7ce77.png`) — the #8876 dedup store working as designed.

### 2. Native save/share round-trip (Android), with the plugin-gap root fix

`10936-native-fix-proof.json` + `10936-share-sheet-open.png` +
`10936-native-share-sheet.mp4` — the real `download-share.ts` code path
(`fetch → Filesystem.writeFile(CACHE) → getUri → Share.share({files:[uri]})`)
firing on-device:

- **Before:** `Capacitor.Plugins.Share=false`, `Filesystem=false` —
  `@capacitor/share` + `@capacitor/filesystem` were never `packages/app`
  dependencies, so the native save/share branch was structurally dead on
  Android AND iOS. (Now added: `packages/app/package.json` carries both at
  `^8.0.0` — verified in-tree.)
- Two more defects found while fixing: `run-mobile-build.mjs`'s AGP9 patch
  stripped `apply plugin: kotlin-android` from the Kotlin-only
  `@capacitor/filesystem` 8.x (→ empty AAR → `ClassNotFound` at boot), and
  Capacitor's `PluginManager.loadPluginClasses()` is all-or-nothing (one
  missing class silently abandoned all 24 auto-registered plugins).
- **After:** `pluginHeaders: 37`, `pluginLoadExceptions: 0`, native filesystem
  write + byte-exact read-back, share sheet opened with the real file
  (Nearby Share / Print / Drive / Maps / Messages).

### 3. Fresh-build iOS simulator launch + attachment surface (own sim)

Captured on a self-created sim `W5-Evidence-iPhone16Pro`
(`D0196FD3-…`, iOS 26.4) — never the physical phone, never udid `39F890C2`.
Installed app renderer built **2026-07-02T07:49Z** (today; confirmed current
via the `[renderer-build … target=ios]` console line).

- `10936-ios-01-first-run.png` — cold first-run: chat-first onboarding on the
  home surface ("Welcome — ask me anything"), quick-prompts + composer.
- `10936-ios-02-after-open.png` — an `Open in "Eliza"?` share/hand-off system
  dialog over the app (the iOS side of the native open/share affordance).
- `10936-fresh-build-firstrun.png` / `10936-onboarding-provider.png` — prior
  fresh-build first-run + provider-choice captures.

## What is N/A this session — iOS on-device live-agent chat round-trip: BLOCKED

I attempted a full live iOS-sim attachment chat round-trip (stage the
`eliza-1-2b` GGUF into the app-support container, arm the in-app full-Bun smoke,
drive a real attachment turn). It is blocked by an on-device runtime defect in
the #11030 family, reproduced twice this session and captured:

- **Local full-Bun engine crashes on boot** — `10936-ios-fullbun-engine-crash.ips`:
  `EXC_BREAKPOINT (SIGTRAP)` in
  `bun.exitThread → pthread_exit → _pthread_tsd_cleanup →
  ___BUG_IN_CLIENT_OF_LIBMALLOC_POINTER_BEING_FREED_WAS_NOT_ALLOCATED → abort`.
  The Bun engine (`ElizaBunEngine abi=3`, `FullBunEngineHost`) double-frees a
  thread-local on exit inside the iOS-26.4 simulator runtime → the whole app
  aborts. This is a native-engine / simulator-libmalloc interaction, not a JS
  or config error — the smoke reached `phase:"running" step:"plugin-imported"`
  before the abort.
- **Remote-mac fallback never connects** — `10936-ios-remote-boot-hang.png`:
  pointing the sim at a live host agent (`http://127.0.0.1:36510`, real
  `@elizaos/plugin-openai` in Cerebras mode, `/api/agents` reports the Eliza
  agent `status: running`) still sits on the "Booting up…" splash. The
  `AgentWatchdog` keeps polling the **local** `ElizaBunRuntime.getStatus`
  (`ready:false`) and no TCP connection to `:36510` is ever opened from the
  sim — the same first-run boot-hang tracked in #11030.

Both are genuine device-runtime blockers, not evidence gaps I can close by the
soft path. The iOS **binary round-trip** claim therefore rests on the Android
byte-exact proof (same content-addressed `/api/media/<sha256>` store, shared
across platforms) + the iOS fresh-build launch/attachment-surface captures; the
iOS **on-device live chat** leg is honestly N/A pending the #11030 boot fix.

## Reproduce (Android round-trip)

See `10936-binary-roundtrip-proof.json` / `10936-native-fix-proof.json` headers
for the exact CDP-over-adb driving commands.

## Reproduce (iOS crash)

Stage `eliza-1-2b-128k.gguf` into
`<app-data>/Library/Application Support/Eliza/local-inference/`, arm
`CapacitorStorage.eliza:ios-full-bun-smoke:request=1`, launch
`xcrun simctl launch --console-pty <udid> ai.elizaos.app` → the app aborts with
the `.ips` signature above within ~15s of `FullBunEngineHost` load.
