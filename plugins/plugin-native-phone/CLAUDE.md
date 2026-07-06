# @elizaos/capacitor-phone

Android phone and Telecom bridge for elizaOS — a Capacitor plugin that exposes native Android phone capabilities (call placement, dialer, call-log access, transcript storage) to Eliza agents running in a Capacitor-wrapped Android app.

## Purpose / role

This is a **Capacitor plugin** (not a standalone elizaOS plugin registered via `Plugin` object). It bridges Android's Telecom and CallLog APIs to JavaScript via `@capacitor/core`'s `registerPlugin`. On Android the Kotlin implementation runs natively; on web/browser every mutating method throws and `listRecentCalls` returns an empty array. The plugin is opt-in: it must be added to the Capacitor app's plugin list in the host Android project.

## Plugin surface

This package does not register elizaOS actions/providers/services/evaluators. It exports a single Capacitor plugin instance and its TypeScript types.

**Exported plugin object:** `Phone` (registered as `"ElizaPhone"`)

**Methods on `PhonePlugin`:**

| Method | Description |
|---|---|
| `getStatus()` | Returns `PhoneStatus` — whether Telecom is available, `CALL_PHONE` permission granted, whether the app is the default dialer, and the current default dialer package name. |
| `placeCall({ number })` | Initiates a call via `TelecomManager.placeCall`. Requires `CALL_PHONE` permission at runtime on Android. |
| `openDialer({ number? })` | Opens the system dialer pre-filled with an optional number. Works without CALL_PHONE permission. |
| `listRecentCalls({ limit?, number? })` | Queries `CallLog.Calls.CONTENT_URI`. Returns up to `limit` entries (default 100, max 500) ordered newest-first. Merges in agent-authored transcripts from SharedPreferences. Requires `READ_CALL_LOG` permission. |
| `saveCallTranscript({ callId, transcript, summary? })` | Persists an agent-authored transcript and optional summary into Android SharedPreferences under the `"eliza_phone_call_transcripts"` store. Returns `{ updatedAt: number }` (epoch ms). |

**Key exported types:** `PhonePlugin`, `PhoneStatus`, `PlaceCallOptions`, `ListRecentCallsOptions`, `SaveCallTranscriptOptions`, `CallLogEntry`, `CallLogType`.

## Layout

```
plugins/plugin-native-phone/
  src/
    definitions.ts      TypeScript interfaces and types (PhonePlugin, PhoneStatus, CallLogEntry, etc.)
    index.ts            registerPlugin call — exports Phone + re-exports definitions
    web.ts              PhoneWeb: WebPlugin fallback — getStatus returns all-false; call/transcript methods throw
    web.test.ts         Vitest unit tests for the PhoneWeb fallback
  android/
    src/main/
      AndroidManifest.xml         Declares permissions: CALL_PHONE, READ_PHONE_STATE, ANSWER_PHONE_CALLS,
                                  MANAGE_OWN_CALLS, READ_CALL_LOG, WRITE_CALL_LOG
      java/ai/eliza/plugins/phone/
        PhonePlugin.kt            @CapacitorPlugin(name="ElizaPhone") — all five PluginMethods
  rollup.config.mjs               Bundles dist/esm → dist/plugin.js (IIFE) + dist/plugin.cjs.js
  package.json
  tsconfig.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-phone clean           # remove build output
bun run --cwd plugins/plugin-native-phone build           # build package artifacts
bun run --cwd plugins/plugin-native-phone typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-phone lint            # mutating Biome check
bun run --cwd plugins/plugin-native-phone lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-phone format          # write formatting
bun run --cwd plugins/plugin-native-phone format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-phone test            # run package tests
bun run --cwd plugins/plugin-native-phone prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-phone build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

No environment variables. No runtime config keys. Android permissions are declared in `AndroidManifest.xml` and must be granted at runtime by the user:

- `android.permission.CALL_PHONE` — required for `placeCall`
- `android.permission.READ_CALL_LOG` — required for `listRecentCalls`
- `android.permission.READ_PHONE_STATE`, `ANSWER_PHONE_CALLS`, `MANAGE_OWN_CALLS`, `WRITE_CALL_LOG` — declared for future Telecom connection service use

## How to extend

**Add a new method:**

1. Define the method signature in `src/definitions.ts` on `PhonePlugin`, adding any new option/return interfaces alongside it.
2. Add a web fallback implementation in `src/web.ts` on `PhoneWeb` (throw or return a safe default).
3. Implement the method in `android/src/main/java/ai/eliza/plugins/phone/PhonePlugin.kt` with `@PluginMethod`.
4. If new Android permissions are needed, declare them in `android/src/main/AndroidManifest.xml`.
5. Run `bun run --cwd plugins/plugin-native-phone build` to verify the TypeScript compiles.

## Conventions / gotchas

- This is a **Capacitor plugin**, not an elizaOS `Plugin` (no actions/providers/evaluators array). Registering it requires adding it to the Capacitor app's plugin list in the Android host project.
- The Capacitor plugin name is `"ElizaPhone"` — this must match the `@CapacitorPlugin(name = "ElizaPhone")` annotation in Kotlin exactly.
- **Instrumented test (issue #9967).** The dialer-status device read lives in `PhoneStatusReader` so it can be exercised on a real device/emulator via `./gradlew :elizaos-capacitor-phone:connectedDebugAndroidTest` (from `packages/app-core/platforms/android`) without a Capacitor `Bridge`/WebView; `getStatus` delegates to it (JS shape unchanged).
- Agent-authored transcripts are stored in Android `SharedPreferences` under the key `"eliza_phone_call_transcripts"`. They are merged into `CallLogEntry` fields `agentTranscript`, `agentSummary`, `agentTranscriptUpdatedAt` at read time. The system-level `transcription` field (from the OS) is a separate field.
- `listRecentCalls` caps at 500 entries (enforced server-side in Kotlin). Passing `limit > 500` or `limit <= 0` results in a rejected call.
- The web fallback for `listRecentCalls` returns `{ calls: [] }` rather than throwing, so call-log-reading code on web will silently get no results rather than an error.
- Build output: `tsc` emits to `dist/esm/`, then rollup bundles to `dist/plugin.js` (IIFE for browsers) and `dist/plugin.cjs.js` (CJS for Node). The `clean` script uses the repo-shared `packages/scripts/rm-path-recursive.mjs`.
- See the repo root `AGENTS.md` for global architecture rules, logger conventions, and ESM constraints.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
