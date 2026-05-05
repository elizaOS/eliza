---
title: "Providers"
sidebarTitle: "Providers"
description: "Provider interface, registration, context injection mechanism, and the built-in Eliza providers."
---

Providers are functions that inject additional text into the agent's context on every conversation turn. They allow plugins and external systems to enrich the prompt with dynamic information without modifying the system prompt template.

## Provider Interface

From `@elizaos/core`:

```typescript
export interface Provider {
  name: string;
  description?: string;
  get(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult>;
}

export interface ProviderResult {
  text?: string;
  data?: Record<string, unknown>;
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique provider identifier (e.g., `"workspace"`, `"emotes"`) |
| `description` | string | Optional description shown in debug output |
| `get()` | function | Called on every turn to produce context text |

The `text` returned by `get()` is appended to the assembled context string. An empty string or `undefined` injects nothing.

## Context Injection Mechanism

At each conversation turn, elizaOS assembles the state by calling every registered provider:

```
Character.system (base system prompt)
  + character.bio lines
  + character.style.all rules
  + provider[0].text
  + provider[1].text
  + ...
  + recent message history
  = final context sent to LLM
```

Provider results are concatenated in registration order.

## Built-in Eliza Providers

The Eliza plugin (`createElizaPlugin()`) registers the following providers:

### Channel Profile Provider

**Name:** `channelProfile` (from `createChannelProfileProvider()`)

Injects channel-specific behavior rules. Adapts the agent's tone for DMs vs. group conversations vs. channels.

**Source:** `eliza/packages/agent/src/providers/simple-mode.ts`

### Workspace Provider

**Name:** `workspace` (from `createWorkspaceProvider()`)

Reads the agent's workspace directory and injects a summary of relevant files into context.

```typescript
createWorkspaceProvider({
  workspaceDir: "~/.eliza/workspace",
})
```

The `workspaceProvider` uses the agent's workspace directory to inject a summary of relevant files.

Files that still contain the default placeholder content (the boilerplate generated on first run) are automatically skipped. Only workspace files you have customized are injected into the prompt.

**Source:** `eliza/packages/agent/src/providers/workspace-provider.ts`

### Admin Trust Provider

**Name:** `adminTrust`

Injects a trust context block indicating whether the current conversation participant has admin privileges.

```
## Trust Level
This conversation is with a trusted admin. Elevated permissions are active.
```

**Source:** `eliza/packages/agent/src/providers/admin-trust.ts`

### Autonomous State Provider

**Name:** from `createAutonomousStateProvider()`

Injects the current autonomous mode status so the agent knows whether it is in interactive or autonomous operation:

```
## Autonomous Mode
Status: active
```

**Source:** `eliza/packages/agent/src/runtime/eliza-plugin.ts` (registered inline)

### Session Key Provider

**Name:** `elizaSessionBridge` from `createSessionKeyProvider()`

Injects the cryptographic session key for the current session, enabling authenticated inter-session communication.

```typescript
createSessionKeyProvider({ defaultAgentId: "main" })
```

**Source:** `eliza/packages/agent/src/providers/session-bridge.ts`

### Session Providers

From `getSessionProviders()` — a set of providers for session-level context (current session metadata, active participants, etc.).

**Source:** `eliza/packages/agent/src/providers/session-utils.ts`

### UI Catalog Provider

**Name:** `uiCatalog`

Injects the Eliza UI component catalog, allowing the agent to compose structured UI elements in its responses.

**Source:** `eliza/packages/agent/src/providers/ui-catalog.ts` (`uiCatalogProvider`)

### Emote Provider (deprecated)

<Warning>
The emote provider has been removed. Available emote IDs are now declared as an `enum` on the `PLAY_EMOTE` action's `emote` parameter. The runtime's `formatActions` function automatically includes the enum values in the prompt's **Available Actions** section, so a separate provider is no longer needed.
</Warning>

To disable emotes entirely, set `character.settings.DISABLE_EMOTES = true`. When this setting is enabled, the `PLAY_EMOTE` action is removed from the plugin at init time so it never appears in the prompt.

### Custom Actions Provider

**Name:** `customActions`

When user-defined custom actions are configured in `eliza.json`, this provider injects the list:

```
## Custom Actions

The following custom actions are available:
- **FETCH_PRICE**: Fetch current token price [params: token (required)]
- **SEND_ALERT**: Send an alert [params: message (required), channel]
```

Returns empty text when no custom actions exist (no token cost).

## Provider Registration

Providers are registered as part of the Plugin object:

```typescript
return {
  name: "my-plugin",
  providers: [
    {
      name: "my-context",
      description: "Injects weather data",
      async get(runtime, message, state) {
        const weather = await fetchWeather();
        return {
          text: `## Current Weather\n\n${weather.description}`,
          data: { weather },
        };
      },
    },
  ],
};
```

## Creating a Custom Provider

To add a provider outside a plugin, include it in the `providers` array of any Plugin you control:

```typescript
import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

const myProvider: Provider = {
  name: "myContext",
  description: "Provides custom context for the agent",

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> {
    // Compute your context
    const data = await fetchSomeData();

    if (!data) {
      return { text: "" }; // Return empty to inject nothing
    }

    return {
      text: [
        "## My Context",
        "",
        `Current value: ${data.value}`,
      ].join("\n"),
      data: { myData: data }, // Optional structured data
    };
  },
};
```

## Provider Ordering

Providers registered in the Eliza plugin follow this order:

```
1. channelProfile     (channel context)
2. workspace          (file system context)
3. adminTrust         (trust level)
4. autonomousState    (autonomy status)
5. sessionKey         (session auth)
6. ...sessionProviders
7. uiCatalog          (UI components)
8. customActions      (user-defined actions)
```

Order matters: context assembled later in the list appears closer to the end of the injected system context and may be more salient to some models.

## Error Handling

Provider errors are caught by the error boundary wrapper in `wrapPluginWithErrorBoundary()`. A crashing provider returns:

```
[Provider myContext error: Cannot read properties of undefined]
```

This marker is visible in context so the LLM can note the failure rather than silently operating with incomplete context.

## Related Pages

- [Personality and Behavior](/agents/personality-and-behavior) — how providers combine with Character fields
- [Core Runtime](/runtime/core) — plugin registration and error boundaries
- [Types](/runtime/types) — Provider and ProviderResult type definitions
