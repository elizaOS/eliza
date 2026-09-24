# @elizaos/plugin-native-contacts

Android address-book overlay app and agent context provider for elizaOS.

## What it does

This plugin adds two capabilities to an Eliza agent running on Android:

1. **Address-book context** — a dynamic provider (`androidContacts`) reads all contacts from the device and injects them into the agent's planning context when a conversation involves contacts or messaging. Each entry includes id, display name, phone numbers, email addresses, and starred status.

2. **Full-screen Contacts app-shell page** — a React UI registered with the elizaOS app-shell system. Supports:
   - Browsing and searching the address book
   - Viewing contact details (phone numbers, email addresses)
   - Creating new contacts (display name, phone, email)
   - Importing contacts from a `.vcf` vCard file

The plugin is **Android-only**. On other platforms the overlay app is not registered and the provider reports an explicit unavailable/error result from the unsupported native bridge.

## Capabilities added to an Eliza agent

| Surface | Name | What it does |
|---------|------|-------------|
| Provider | `androidContacts` | Injects the complete read-only address book into the planner for `contacts` and `messaging` conversation contexts. Requires ADMIN role session. |
| App-shell page (UI) | Contacts | Full-screen address-book UI: list, detail, create, import vCard. |

Note: live dialling is not part of this plugin. Placing a call remains in the Phone app (`PLACE_CALL` action).

## Installation

`@elizaos/plugin-native-contacts` is an elizaOS plugin. Add it to your agent's plugin list:

```ts
import { appContactsPlugin } from "@elizaos/plugin-native-contacts/plugin";

const agent = new AgentRuntime({
  plugins: [appContactsPlugin],
  // ...
});
```

The `./plugin` export is the runtime adapter entry point. The full package entry (`@elizaos/plugin-native-contacts`) additionally exports the UI components and a legacy overlay-app registration helper for explicit consumers.

To register the canonical app-shell page (done automatically by the host on elizaOS):

```ts
import "@elizaos/plugin-native-contacts/register"; // leaves the app shell unchanged on non-elizaOS
```

## Required permissions

No environment variables are needed. The plugin requires the following Android permissions to be granted at the OS level:

- `READ_CONTACTS`
- `WRITE_CONTACTS`

These are requested by `@elizaos/plugin-native-contacts/bridge` at runtime.

## Limitations

- **Android only.** The native Contacts API is not available on iOS, web, or desktop.
- **Read-mostly.** The native layer does not expose contact update or delete. The detail view is read-only; create and import (vCard) are the only write operations.
- **Prompt integrity.** The `androidContacts` provider does not request a result limit; it preserves the complete address book for planner context.

## Native bridge

The Android implementation and web fallback ship in this workspace. Import device APIs from `@elizaos/plugin-native-contacts/bridge`; this entry does not load UI registration. The package root exports the application surface, `/plugin` the runtime plugin, and `/register` the app-shell registration. Capacitor discovers the Android implementation through the package manifest. Builds emit ESM and declarations into `dist/`.

The package owns `tsconfig.json` for its React surface and native bridge.
Typechecking resolves the bridge self-import from `src/bridge.ts` so it works
before a build. `tsconfig.build.json` remains generated from the shared plugin
build configuration and owns emitted JavaScript and declarations.
