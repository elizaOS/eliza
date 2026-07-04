# @elizaos/capacitor-messages

Capacitor plugin that gives an Eliza agent on Android the ability to send and read native SMS/MMS messages via the Android Telephony API.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin — not an elizaOS `Plugin` object. It bridges the Android `SmsManager` and `content://sms` provider into a typed JavaScript API. It is consumed by any Capacitor-based Eliza app running on Android; the web fallback throws on `sendSms` and returns an empty list from `listMessages`. It is opt-in: register it in your Capacitor Android project, request the required runtime permissions, and import `Messages` from `@elizaos/capacitor-messages`.

## Plugin surface

This plugin does **not** register elizaOS actions, providers, evaluators, or services. It exposes a Capacitor plugin interface named `ElizaMessages` with two methods:

| Method | Description |
|---|---|
| `Messages.sendSms({ address, body })` | Sends an SMS (multipart if needed); waits for radio confirmation; persists to Android sent folder. Returns `{ messageId, messageUri }`. |
| `Messages.listMessages({ limit?, threadId? })` | Reads up to `limit` messages (default 100, max 500) from the system SMS store, optionally filtered by `threadId`. Returns `{ messages: SmsMessageSummary[] }`. |

## Layout

```
plugins/plugin-native-messages/
  src/
    index.ts          Entry point — calls registerPlugin("ElizaMessages", { web: loadWeb })
    definitions.ts    TypeScript interfaces: MessagesPlugin, SendSmsOptions, SendSmsResult,
                      ListMessagesOptions, SmsMessageSummary
    web.ts            Web fallback — sendSms throws; listMessages returns []
    web.test.ts       Vitest unit tests for the web fallback
  android/
    src/main/
      AndroidManifest.xml               READ_SMS / SEND_SMS / RECEIVE_SMS / RECEIVE_MMS / RECEIVE_WAP_PUSH permission declarations
      java/ai/eliza/plugins/messages/
        MessagesPlugin.kt               Capacitor @CapacitorPlugin("ElizaMessages"); implements
                                        sendSms (SmsManager + BroadcastReceiver delivery receipt)
                                        and listMessages (ContentResolver query on content://sms)
  rollup.config.mjs   Bundles dist/esm → dist/plugin.js (IIFE) and dist/plugin.cjs.js
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-messages clean           # remove build output
bun run --cwd plugins/plugin-native-messages build           # build package artifacts
bun run --cwd plugins/plugin-native-messages typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-messages lint            # mutating Biome check
bun run --cwd plugins/plugin-native-messages lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-messages format          # write formatting
bun run --cwd plugins/plugin-native-messages format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-messages test            # run package tests
bun run --cwd plugins/plugin-native-messages prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-messages build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

No environment variables or elizaOS config keys. The plugin reads no `.env` values. All behaviour is determined at call time:

- `SEND_SMS` Android runtime permission — required for `sendSms`.
- `READ_SMS` Android runtime permission — required for `listMessages`.

Both permissions are declared in `android/src/main/AndroidManifest.xml`. The host app must request them at runtime before calling either method.

## How to extend

**Add a new Capacitor method (e.g., `deleteSms`):**

1. Add the method signature to `MessagesPlugin` in `src/definitions.ts`.
2. Add a web fallback in `src/web.ts` that throws `"deleteSms is only available on Android."`.
3. Implement `@PluginMethod fun deleteSms(call: PluginCall)` in `android/src/main/java/ai/eliza/plugins/messages/MessagesPlugin.kt` using the ContentResolver.
4. If the new method needs an Android permission, declare it in `AndroidManifest.xml` and check it with `hasPermission(Manifest.permission.*)` before proceeding.
5. Run `bun run --cwd plugins/plugin-native-messages build` to regenerate `dist/`.

## Conventions / gotchas

- **Android only.** The web fallback exists solely to satisfy Capacitor's plugin registration contract. Do not add real web logic here.
- **Instrumented test (issue #9967).** The `content://sms` query lives in `MessagesReader`; an on-device read test (`android/src/androidTest/.../MessagesReaderInstrumentedTest.kt`, `GrantPermissionRule`) reads back a marker SMS. It is **emulator-orchestrated** (`adb -s <emulator> emu sms send <number> "…Eliza-9967-SMS-roundtrip…"` then `connectedDebugAndroidTest`/`am instrument`) and `Assume`-skips when the marker is absent, so it never reads a real device's private inbox. `listMessages` delegates to the reader (JS shape unchanged).
- **Multipart SMS.** `sendSms` uses `SmsManager.divideMessage` and tracks one `BroadcastReceiver` delivery intent per part; the call resolves only after all parts confirm. Do not assume a single `sendTextMessage` call for long messages.
- **Delivery receipt vs. sent receipt.** The BroadcastReceiver listens for `SENT` status only. Delivery receipts (`DELIVERED`) are not tracked.
- **Limit clamp.** `listMessages` rejects if `limit` is outside `[1, 500]`. The Android SMS provider can be large; do not request unbounded results.
- **Plugin name.** The Capacitor plugin name is `"ElizaMessages"` (set in both `index.ts` and the Kotlin `@CapacitorPlugin` annotation). The npm package name is `@elizaos/capacitor-messages`. The directory is `plugin-native-messages`. All three differ — keep them in sync if renaming.
- **Build output.** `tsc` emits to `dist/esm/`; rollup then bundles `dist/esm/index.js` into `dist/plugin.js` (IIFE) and `dist/plugin.cjs.js`. The `exports` field in package.json uses `dist/esm/index.js` for ESM consumers and `dist/plugin.cjs.js` for CJS.
- **Peer dep.** `@capacitor/core ^8.3.1` is a peer dependency; the host Capacitor app owns the exact version.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
