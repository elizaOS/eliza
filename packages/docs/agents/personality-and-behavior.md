---
title: "Personality and Behavior"
sidebarTitle: "Personality & Behavior"
description: "How Eliza composes agent personality from Character fields into a live system prompt, and how providers inject additional context."
---

Eliza agent personality is composed from several layers at runtime. The Character fields defined in `eliza.json` (see [Character Interface](./character-interface)) are the primary source, combined with context injected by providers at each conversation turn.

## How Personality Is Composed

At startup, `buildCharacterFromConfig()` assembles a Character object and passes it to `AgentRuntime`. The elizaOS core then constructs the system prompt from these fields:

1. **`character.system`** — The base system prompt template. The `{{name}}` placeholder is replaced with the agent's actual name.
2. **`character.bio`** — Each string in the bio array is appended to the prompt to fill out the agent's identity.
3. **`character.adjectives`** — Personality adjectives (e.g., `["witty", "direct"]`) inform how the model should present itself.
4. **`character.style.all`** — Rules that apply to every response.
5. **`character.topics`** — Subject areas the agent engages with, helping the model stay in character on relevant topics.

### Default System Prompt

When no `system` field is set in the agent config, the runtime uses:

```
You are {{name}}, an autonomous AI agent powered by elizaOS.
```

After template resolution this becomes:

```
You are Luna, an autonomous AI agent powered by elizaOS.
```

### Onboarding-Generated Prompts

When a user completes onboarding, Eliza writes a full agent configuration into `eliza.json`. The onboarding flow (in `eliza/packages/agent/src/runtime/eliza.ts`) walks through several steps:

1. **Agent name** — pick from random suggestions or enter a custom name.
2. **Style preset** — select a personality template from `STYLE_PRESETS` (defined in `eliza/packages/shared/src/onboarding-presets.ts`). The chosen template supplies `bio`, `system`, `style`, `adjectives`, `topics`, `postExamples`, and `messageExamples` in a single operation.
3. **Model provider** — select an LLM provider (Anthropic, OpenAI, OpenRouter, Gemini, Groq, etc.) and enter an API key. The key is persisted into `config.env` and set in `process.env` for the current run. Skipped if an existing key is detected in the environment.
4. **Wallet setup** — optionally generate fresh EVM + Solana keypairs or import existing private keys. Keys are stored in `config.env` (`EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`).
5. **Skills registry** — if no `SKILLS_REGISTRY` or `CLAWHUB_REGISTRY` URL is set, defaults to `https://clawhub.ai`. The `SKILLSMP_API_KEY` is also persisted if present.

## Style Object Composition

The `style` object has three sub-keys that apply at different context levels:

```json
{
  "style": {
    "all":  ["Be concise", "Avoid hedging"],
    "chat": ["Match the user's energy", "Keep replies short in casual conversation"],
    "post": ["Write in first person", "No hashtags", "Under 280 characters"]
  }
}
```

| Key | When applied |
|---|---|
| `all` | Every response regardless of channel |
| `chat` | Direct-message and chat channel responses |
| `post` | When generating social-media style posts |

## Message Examples

`messageExamples` are multi-turn conversation samples that demonstrate how the agent should sound in practice. The format stored in config:

```json
[
  [
    { "user": "user",   "content": { "text": "What is DeFi?" } },
    { "user": "Luna",   "content": { "text": "DeFi is finance with no middlemen. Smart contracts replace banks." } }
  ]
]
```

Each outer array is a separate conversation. Each inner array is one turn. These are passed to the core runtime to use as few-shot examples during prompt construction.

## Post Examples

`postExamples` are short standalone strings that demonstrate the agent's social-media writing style:

```json
{
  "postExamples": [
    "Yield farming is just renting money to strangers on the internet.",
    "The best trade I ever made was not trading."
  ]
}
```

## Provider Context Injection

At every conversation turn, providers registered with the runtime inject additional context strings that are appended to the effective system prompt. The Eliza plugin registers several providers:

### Channel Profile Provider

`createChannelProfileProvider()` injects channel-specific behavior rules based on the current message channel (DM, group, etc.). Created in `eliza/packages/agent/src/providers/simple-mode.ts`.

### Workspace Provider

`createWorkspaceProvider()` reads the agent's workspace directory and injects a summary of relevant files.

```typescript
const provider = createWorkspaceProvider({
  dir: agentWorkspaceDir,
});
```

Here `config` is the `ElizaPluginConfig` object passed to `createElizaPlugin()`, not the top-level `ElizaConfig`.

### Admin Trust Provider

`adminTrustProvider` from `eliza/packages/agent/src/providers/admin-trust.ts` injects information about whether the current user has admin privileges, enabling the agent to make trust-appropriate decisions.

### Autonomous State Provider

`createAutonomousStateProvider()` injects the current autonomous mode status so the agent knows whether it's running in interactive or autonomous mode.

### Emote action

Available emote IDs are declared as an `enum` on the `PLAY_EMOTE` action's `emote` parameter. The runtime automatically includes the allowed values in the **Available Actions** section of the prompt, so a separate emote provider is no longer needed.

To disable emotes entirely, set `character.settings.DISABLE_EMOTES = true`. This removes the `PLAY_EMOTE` action at plugin init time so it never appears in the prompt.

### Custom Actions Provider

If the user has defined custom actions in `eliza.json`, the custom actions provider injects a list of available actions into the context:

```
## Custom Actions

The following custom actions are available:
- **FETCH_PRICE**: Fetches current token price [params: token (required)]
- **SEND_TWEET**: Posts a tweet [params: text (required)]
```

When no custom actions are configured, the provider returns empty text (no token cost).

### UI Catalog Provider

`uiCatalogProvider` from `eliza/packages/agent/src/providers/ui-catalog.ts` injects the Eliza UI component catalog, allowing the agent to compose structured UI responses.

## Session Key Provider

`createSessionKeyProvider()` injects the current session's cryptographic key, enabling the agent to authenticate inter-session communication.

## Provider Registration in the Plugin

All providers are registered through the Eliza plugin:

```typescript
return {
  name: "eliza",
  providers: [
    createChannelProfileProvider(),
    createWorkspaceProvider({ workspaceDir, maxCharsPerFile }),
    adminTrustProvider,
    createAutonomousStateProvider(),
    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
    uiCatalogProvider,
    customActionsProvider,
  ],
};
```

## Related Pages

- [Character Interface](./character-interface) — the Character schema and field definitions
- [Memory and State](./memory-and-state) — how conversational history is injected
- [Runtime Providers](/runtime/providers) — provider interface reference
