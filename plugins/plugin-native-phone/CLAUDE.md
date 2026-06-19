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

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-native-phone build     # tsc + rollup (produces dist/)
bun run --cwd plugins/plugin-native-phone clean     # removes dist/
bun run --cwd plugins/plugin-native-phone test      # vitest run
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
- Agent-authored transcripts are stored in Android `SharedPreferences` under the key `"eliza_phone_call_transcripts"`. They are merged into `CallLogEntry` fields `agentTranscript`, `agentSummary`, `agentTranscriptUpdatedAt` at read time. The system-level `transcription` field (from the OS) is a separate field.
- `listRecentCalls` caps at 500 entries (enforced server-side in Kotlin). Passing `limit > 500` or `limit <= 0` results in a rejected call.
- The web fallback for `listRecentCalls` returns `{ calls: [] }` rather than throwing, so call-log-reading code on web will silently get no results rather than an error.
- Build output: `tsc` emits to `dist/esm/`, then rollup bundles to `dist/plugin.js` (IIFE for browsers) and `dist/plugin.cjs.js` (CJS for Node). The `clean` script uses the repo-shared `packages/scripts/rm-path-recursive.mjs`.
- See the repo root `AGENTS.md` for global architecture rules, logger conventions, and ESM constraints.
