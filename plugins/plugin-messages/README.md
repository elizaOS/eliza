# @elizaos/plugin-messages

Android SMS plugin for elizaOS. Adds an SMS inbox, thread viewer, and compose surface to the elizaOS agent shell on Android.

## What it does

- Reads SMS threads and message history from the Android SMS store via the native capacitor bridge.
- Lets users and agents compose and send text messages.
- Surfaces the Android default SMS role status and prompts to request it when not held.
- Registers three views: a full overlay app, an XR variant, and a TUI (terminal) variant for agent automation.

## Platform requirement

**Android only.** The plugin is marked `androidOnly: true`. The overlay app registration is skipped on non-Android runtimes.

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
| `/messages` | Full SMS inbox and composer overlay |
| `/messages` (XR) | XR variant of the same surface |
| `/messages/tui` | Terminal-style view for agent automation |

## Android SMS role

Reading and sending SMS requires Android to grant the default SMS role (`android.app.role.SMS`) to the elizaOS app. When the role is not held, the UI shows a "Set default SMS" banner. The role can also be requested programmatically through the TUI `interact()` API.

## Agent automation (TUI)

The `MessagesTuiView` component and `interact()` function expose a programmatic terminal API:

```ts
import { interact } from "@elizaos/plugin-messages";

// List threads
const { threads, ownsSmsRole } = await interact("terminal-list-threads", { limit: 50 });

// Send an SMS
await interact("terminal-send-sms", { address: "+15550100", body: "Hello" });

// Request the default SMS role
await interact("terminal-request-sms-role");
```

The TUI view also writes its full state to a `data-view-state` attribute on the root element, which test harnesses and agents can read without parsing inner DOM structure.

## Dependencies

- `@elizaos/capacitor-messages` — native SMS bridge (`Messages.listMessages`, `Messages.sendSms`)
- `@elizaos/capacitor-system` — system role API (`System.getStatus`, `System.requestRole`)
- `@elizaos/ui` — shared component library and overlay app registration
- `@elizaos/core` — plugin type definitions

## Building

```bash
bun run --cwd plugins/plugin-messages build
```

This runs `build:js` (tsup library bundle), `build:views` (vite view bundle at `dist/views/bundle.js`), and `build:types` (TypeScript declarations).
