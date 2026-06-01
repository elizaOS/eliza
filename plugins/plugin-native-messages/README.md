# @elizaos/capacitor-messages

Android SMS/MMS bridge for elizaOS — a Capacitor plugin that lets an Eliza agent send outbound SMS messages and read the device SMS inbox via the Android Telephony API.

## What it does

- **Send SMS** — dispatches single or multipart text messages using `SmsManager`, waits for radio-layer delivery confirmation, and writes the sent message to the Android sent folder.
- **Read SMS** — queries the system `content://sms` provider and returns messages sorted newest-first, with optional filtering by conversation thread.

The web/browser fallback reports messaging unavailable (`sendSms` throws; `listMessages` returns an empty list). This plugin is meaningful only on Android.

## Installation

```bash
npm install @elizaos/capacitor-messages
npx cap sync android
```

## Android permissions

Declare in your app's `AndroidManifest.xml` (already present in the plugin manifest, but the host app must request at runtime):

| Permission | Required by |
|---|---|
| `android.permission.SEND_SMS` | `sendSms` |
| `android.permission.READ_SMS` | `listMessages` |
| `android.permission.RECEIVE_SMS` | Receiving inbound SMS (future use) |

Request both permissions before calling any plugin method. Calls made without the required permission are rejected immediately.

## API

### `Messages.sendSms(options)`

```typescript
import { Messages } from "@elizaos/capacitor-messages";

const result = await Messages.sendSms({
  address: "+15550001234",  // E.164 or local format accepted by SmsManager
  body: "Hello from Eliza",
});
// result: { messageId: string, messageUri: string }
```

Long messages are automatically split into multipart SMS by `SmsManager.divideMessage`. The call resolves only after every part has been confirmed by the radio layer.

### `Messages.listMessages(options?)`

```typescript
const { messages } = await Messages.listMessages({
  limit: 50,       // 1–500, default 100
  threadId: "42",  // optional — filter to one conversation
});
// messages: SmsMessageSummary[]
```

Each `SmsMessageSummary` contains: `id`, `threadId`, `address`, `body`, `date` (Unix ms), `type` (Telephony.Sms constants), `read`.

## Types

```typescript
interface SendSmsOptions   { address: string; body: string }
interface SendSmsResult    { messageId: string; messageUri: string }
interface ListMessagesOptions { limit?: number; threadId?: string }
interface SmsMessageSummary {
  id: string; threadId: string; address: string;
  body: string; date: number; type: number; read: boolean;
}
```

## Building from source

```bash
bun run --cwd plugins/plugin-native-messages build
```

Requires `bun`, `tsc`, and `rollup` (all listed as dev dependencies).

## License

MIT
