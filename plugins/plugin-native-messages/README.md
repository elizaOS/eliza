# @elizaos/plugin-native-messages

Android SMS plugin for elizaOS. Adds an SMS inbox, thread viewer, and compose surface to the elizaOS agent shell on Android.

The root TypeScript configuration covers the React view and native bridge together.
It is package-owned because its JSX and TypeScript import settings differ from
the generated bridge-only scaffold. Production output uses `tsconfig.build.json`.

## What it does

- Reads SMS threads and message history from the Android SMS store via the native capacitor bridge.
- Lets users and agents compose and send text messages.
- Surfaces the Android default SMS role status and prompts to request it when not held.
- Registers one GUI view for the SMS inbox, thread viewer, and compose surface.

## Platform requirement

**Android only.** The plugin is marked `androidOnly: true`.

## Enabling the plugin

Add `@elizaos/plugin-native-messages` to the agent's plugin list when constructing the runtime:

```ts
import messagesPlugin from "@elizaos/plugin-native-messages";

const runtime = new AgentRuntime({
  // ...
  plugins: [messagesPlugin],
});
```

## Views registered

| Path | Description |
|---|---|
| `/messages` | Full SMS inbox and composer overlay |

## Android SMS role

Reading and sending SMS requires Android to grant the default SMS role (`android.app.role.SMS`) to the elizaOS app. When the role is not held, the UI shows a "Set default SMS" banner. The role can also be requested programmatically through the view `interact()` API.

## Agent Automation

The view-bundle `interact()` function exposes programmatic capabilities:

```ts
import { interact } from "@elizaos/plugin-native-messages/components/messages-interact";

// List threads
const { threads, ownsSmsRole } = await interact("list-threads", { limit: 50 });

// Send an SMS
await interact("send-sms", { address: "+15550100", body: "Hello" });

// Request the default SMS role
await interact("request-sms-role");
```

## Dependencies

- `@elizaos/plugin-native-messages/bridge` — native SMS bridge (`Messages.listMessages`, `Messages.sendSms`)
- `@elizaos/capacitor-system` — system role API (`System.getStatus`, `System.requestRole`)
- `@elizaos/ui` — shared component library and agent-surface/navigation helpers
- `@elizaos/core` — plugin type definitions

## Building

```bash
bun run --cwd plugins/plugin-native-messages build
```

This runs `build:js` (tsup library bundle), `build:views` (vite view bundle at `dist/views/bundle.js`), and `build:types` (TypeScript declarations).

## Native bridge

The Android implementation and web fallback ship in this workspace. Import device APIs from `@elizaos/plugin-native-messages/bridge`; this entry does not load UI registration. The package root exports the application surface, `/plugin` the runtime plugin, and `/register` the app-shell registration. Capacitor discovers the Android implementation through the package manifest. Builds emit ESM and declarations into `dist/`.
