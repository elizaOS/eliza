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
  android/
    src/main/
      AndroidManifest.xml               READ_SMS / SEND_SMS / RECEIVE_SMS permission declarations
      java/ai/eliza/plugins/messages/
        MessagesPlugin.kt               Capacitor @CapacitorPlugin("ElizaMessages"); implements
                                        sendSms (SmsManager + BroadcastReceiver delivery receipt)
                                        and listMessages (ContentResolver query on content://sms)
  rollup.config.mjs   Bundles dist/esm → dist/plugin.js (IIFE) and dist/plugin.cjs.js
  tsconfig.json
  package.json
```

## Commands

Scripts defined in this package.json:

```bash
bun run --cwd plugins/plugin-native-messages build          # clean + tsc + rollup
bun run --cwd plugins/plugin-native-messages clean          # rm -rf dist
bun run --cwd plugins/plugin-native-messages prepublishOnly # same as build
```

## Config / env vars

No environment variables or elizaOS config keys. The plugin reads no `.env` values. All behaviour is determined at call time:

- `SEND_SMS` Android runtime permission — required for `sendSms`.
- `READ_SMS` Android runtime permission — required for `listMessages`.

Both permissions are declared in `android/src/main/AndroidManifest.xml`. The host app must request them at runtime before calling either method.

## How to extend

**Add a new Capacitor method (e.g., `deleteSms`):**

1. Add the method signature to `MessagesPlugin` in `src/definitions.ts`.
2. Add a stub in `src/web.ts` that throws `"deleteSms is only available on Android."`.
3. Implement `@PluginMethod fun deleteSms(call: PluginCall)` in `android/src/main/java/ai/eliza/plugins/messages/MessagesPlugin.kt` using the ContentResolver.
4. If the new method needs an Android permission, declare it in `AndroidManifest.xml` and check it with `hasPermission(Manifest.permission.*)` before proceeding.
5. Run `bun run --cwd plugins/plugin-native-messages build` to regenerate `dist/`.

## Conventions / gotchas

- **Android only.** The web fallback exists solely to satisfy Capacitor's plugin registration contract. Do not add real web logic here.
- **Multipart SMS.** `sendSms` uses `SmsManager.divideMessage` and tracks one `BroadcastReceiver` delivery intent per part; the call resolves only after all parts confirm. Do not assume a single `sendTextMessage` call for long messages.
- **Delivery receipt vs. sent receipt.** The BroadcastReceiver listens for `SENT` status only. Delivery receipts (`DELIVERED`) are not tracked.
- **Limit clamp.** `listMessages` rejects if `limit` is outside `[1, 500]`. The Android SMS provider can be large; do not request unbounded results.
- **Plugin name.** The Capacitor plugin name is `"ElizaMessages"` (set in both `index.ts` and the Kotlin `@CapacitorPlugin` annotation). The npm package name is `@elizaos/capacitor-messages`. The directory is `plugin-native-messages`. All three differ — keep them in sync if renaming.
- **Build output.** `tsc` emits to `dist/esm/`; rollup then bundles `dist/esm/index.js` into `dist/plugin.js` (IIFE) and `dist/plugin.cjs.js`. The `exports` field in package.json uses `dist/esm/index.js` for ESM consumers and `dist/plugin.cjs.js` for CJS.
- **Peer dep.** `@capacitor/core ^8.3.1` is a peer dependency; the host Capacitor app owns the exact version.
