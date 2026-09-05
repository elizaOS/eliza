# @elizaos/plugin-messages

Android SMS plugin for elizaOS. Adds an SMS inbox, thread viewer, and compose surface to the elizaOS agent shell on Android.

## What it does

- Reads SMS threads and message history from the Android SMS store via the native capacitor bridge.
- Lets users compose and send text messages; mutation capabilities require direct human interaction.
- Surfaces the Android default SMS role status and prompts to request it when not held.
- Registers one GUI view for the SMS inbox, thread viewer, and compose surface.

## Platform requirement

**Android only.** The plugin is marked `androidOnly: true`.

## Enabling the plugin

Add `@elizaos/plugin-messages` to the agent's plugin list when constructing the runtime:

```ts
import messagesPlugin from "@elizaos/plugin-messages";

const runtime = new AgentRuntime({
  // ...
  plugins: [messagesPlugin],
});
```

## Views registered

| Path | Description |
|---|---|
| `/messages` | ADMIN-gated SMS inbox and composer overlay |

## Android SMS role

Reading and sending SMS requires Android to grant the default SMS role (`android.app.role.SMS`) to the elizaOS app. When the role is not held, the UI shows a "Set default SMS" banner. Sending SMS and requesting the role are human-only view capabilities.

## View interaction contract

The view bundle exposes one planner-authorized read. Its mutation handlers are
for the trusted human UI host and are not available to planner dispatch:

```ts
import { interact } from "@elizaos/plugin-messages/components/messages-interact";

// List threads
const { threads, ownsSmsRole } = await interact("list-threads");

// Trusted human UI host only; planner dispatch rejects these capabilities.
await interact("send-sms", { address: "+15550100", body: "Hello" });

// Request the default SMS role
await interact("request-sms-role");
```

Planner dispatch requires an `ADMIN` caller. Only `list-threads` is agent-authorized; it rejects rather than returning a possibly incomplete 500-message prefix or fabricated SMS-role state. `send-sms`, `request-sms-role`, and generic renderer state, element, focus, fill, and click operations are denied before mounted-view dispatch.

## Dependencies

- `@elizaos/capacitor-messages` — native SMS bridge (`Messages.listMessages`, `Messages.sendSms`)
- `@elizaos/capacitor-system` — system role API (`System.getStatus`, `System.requestRole`)
- `@elizaos/ui` — shared component library and agent-surface/navigation helpers
- `@elizaos/core` — plugin type definitions

## Building

```bash
bun run --cwd plugins/plugin-messages build
```

This runs `build:js` (tsup library bundle), `build:views` (vite view bundle at `dist/views/bundle.js`), and `build:types` (TypeScript declarations).
