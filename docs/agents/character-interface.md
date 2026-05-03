---
title: "Character Interface"
sidebarTitle: "Character Interface"
description: "Schema, field reference, and examples for the elizaOS Character object used by Eliza agents."
---

The Character object is the primary definition of an agent's identity. Eliza builds a Character at startup from `eliza.json` using `buildCharacterFromConfig()`, then passes it to `AgentRuntime`. All personality fields are sourced from `config.agents.list[0]` (set during onboarding or edited directly).

## Character Hub Surfaces

In the dashboard, character work is grouped into five hub sections:

1. **Overview** -- the top-level summary of the agent's current character state.
2. **Personality** -- the editable Character fields documented below, including identity, prompt, style, topics, adjectives, and examples.
3. **Knowledge** -- uploaded documents and retrieval material associated with the agent.
4. **Experience** -- surfaced runtime learnings and experience signals that inform future behavior.
5. **Relationships** -- relationship and contact context associated with the agent.

Only the **Personality** section maps directly to the core `Character` schema. **Knowledge**, **Experience**, and **Relationships** surface adjacent runtime data in the same hub so you can review the full agent profile in one place.

## Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Agent display name. Resolved from `agents.list[0].name`, then `ui.assistant.name`, then `"Eliza"`. |
| `bio` | `string[]` | No | Array of biography lines injected into the system context. Defaults to `["{{name}} is an AI assistant powered by Eliza and elizaOS."]` |
| `system` | `string` | No | System prompt template. Defaults to `"You are {{name}}, an autonomous AI agent powered by elizaOS."` |
| `style` | `object` | No | Communication style rules object. Contains `all`, `chat`, and `post` sub-arrays. |
| `adjectives` | `string[]` | No | Personality adjectives (e.g., `["witty", "playful", "direct"]`). Used in prompt composition. |
| `topics` | `string[]` | No | Subject areas the agent engages with (e.g., `["crypto", "art", "philosophy"]`). |
| `postExamples` | `string[]` | No | Example social-media posts demonstrating the agent's voice. |
| `messageExamples` | `Array<Array<{user, content: {text}}>>` | No | Example conversations. Each entry is a conversation (array of turns). |
| `secrets` | `Record<string, string>` | No | API keys and provider credentials, populated from `process.env` at startup. |

## Style Object

The `style` object controls how the agent adapts its tone across different contexts:

```json
{
  "style": {
    "all": ["Be concise", "Use line breaks between thoughts"],
    "chat": ["Match the user's energy", "Keep responses under 3 sentences when possible"],
    "post": ["Write in first person", "No hashtags"]
  }
}
```

| Sub-key | Context |
|---|---|
| `all` | Applied in every response |
| `chat` | Applied in direct message / chat contexts |
| `post` | Applied in social media post generation |

## Source Mapping: Config to Character

`buildCharacterFromConfig()` in `eliza/packages/agent/src/runtime/eliza.ts` performs the following mapping:

```typescript
// Name resolution
const agentEntry = config.agents?.list?.[0];
const name = agentEntry?.name ?? config.ui?.assistant?.name ?? "Eliza";

// Personality from agent config entry (set during onboarding)
const bio      = agentEntry?.bio ?? ["{{name}} is an AI assistant powered by Eliza and elizaOS."];
const system   = agentEntry?.system ?? "You are {{name}}, an autonomous AI agent powered by elizaOS.";
const style    = agentEntry?.style;
const adjectives = agentEntry?.adjectives;
const topics   = agentEntry?.topics;
```

`messageExamples` entries go through a format normalisation step: the config stores `{ user, content: { text } }` while the core `Character` type expects a `name` field. The mapping is:

```typescript
const mappedExamples = messageExamples?.map((convo) =>
  convo.map((msg) => ({ ...msg, name: msg.user })),
);
```

## Secrets Injection

Eliza collects the following environment variables into `character.secrets` so that loaded plugins can find them at runtime without reading `process.env` directly:

```
# LLM Provider Keys
ANTHROPIC_API_KEY             OPENAI_API_KEY
GOOGLE_API_KEY                GOOGLE_GENERATIVE_AI_API_KEY
GROQ_API_KEY                  XAI_API_KEY
OPENROUTER_API_KEY

# AI Gateway
AI_GATEWAY_API_KEY            AIGATEWAY_API_KEY
AI_GATEWAY_BASE_URL           AI_GATEWAY_SMALL_MODEL
AI_GATEWAY_LARGE_MODEL        AI_GATEWAY_EMBEDDING_MODEL
AI_GATEWAY_EMBEDDING_DIMENSIONS
AI_GATEWAY_IMAGE_MODEL        AI_GATEWAY_TIMEOUT_MS

# Local Models
OLLAMA_BASE_URL

# Connector Tokens
DISCORD_API_TOKEN             DISCORD_APPLICATION_ID
DISCORD_BOT_TOKEN             TELEGRAM_BOT_TOKEN
SLACK_BOT_TOKEN               SLACK_APP_TOKEN
SLACK_USER_TOKEN              SIGNAL_ACCOUNT
MSTEAMS_APP_ID                MSTEAMS_APP_PASSWORD
MATTERMOST_BOT_TOKEN          MATTERMOST_SERVER_URL

# ElizaCloud
ELIZAOS_CLOUD_API_KEY         ELIZAOS_CLOUD_BASE_URL
ELIZAOS_CLOUD_ENABLED

# Wallet / Blockchain
EVM_PRIVATE_KEY               SOLANA_PRIVATE_KEY
ALCHEMY_API_KEY               HELIUS_API_KEY
BIRDEYE_API_KEY               SOLANA_RPC_URL

# X402 Payments
X402_PRIVATE_KEY              X402_NETWORK
X402_PAY_TO                   X402_FACILITATOR_URL
X402_MAX_PAYMENT_USD          X402_MAX_TOTAL_USD
X402_ENABLED                  X402_DB_PATH
```

Only variables that have a non-empty value are included.

## AgentConfig Personality Fields

These fields live in `eliza.json` under `agents.list[0]` and map directly to Character:

```typescript
export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;       // string or { primary?, fallbacks? }
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  humanDelay?: HumanDelayConfig;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  // Personality (set during onboarding)
  bio?: string[];
  system?: string;
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  adjectives?: string[];
  topics?: string[];
  postExamples?: string[];
  messageExamples?: Array<Array<{ user: string; content: { text: string } }>>;
  subagents?: {
    allowAgents?: string[];
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    workspaceAccess?: "none" | "ro" | "rw";
    sessionToolsVisibility?: "spawned" | "all";
    scope?: "session" | "agent" | "shared";
    perSession?: boolean;
    workspaceRoot?: string;
    docker?: SandboxDockerSettings;
    browser?: SandboxBrowserSettings;
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
  cloud?: {
    cloudAgentId?: string;
    lastStatus?: string;
    lastProvisionedAt?: string;
  };
};
```

## Example eliza.json Agent Entry

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Luna",
        "bio": [
          "Luna is a crypto-native AI agent with strong opinions on DeFi.",
          "She combines technical depth with a playful, irreverent tone."
        ],
        "system": "You are Luna, a sharp and witty AI agent. Be direct, be helpful, be yourself.",
        "style": {
          "all": ["Use plain language", "No unnecessary filler"],
          "chat": ["Keep it conversational", "Match enthusiasm level"],
          "post": ["First-person voice", "No corporate speak"]
        },
        "adjectives": ["sharp", "playful", "direct", "crypto-native"],
        "topics": ["DeFi", "NFTs", "on-chain data", "AI agents"],
        "postExamples": [
          "Yield farming is just renting money to strangers on the internet and hoping they're honest.",
          "The best trade I ever made was not trading."
        ],
        "messageExamples": [
          [
            { "user": "user", "content": { "text": "What's your take on Ethereum?" } },
            { "user": "Luna", "content": { "text": "It's the world computer. Slow, expensive, and irreplaceable." } }
          ]
        ]
      }
    ]
  }
}
```

## Merging with Defaults

The character is finalised via `mergeCharacterDefaults()` from `@elizaos/core`, which fills in any fields not explicitly provided. The merged character is then passed to `AgentRuntime`.

## Related Pages

- [Personality and Behavior](./personality-and-behavior) — how fields compose into the live system prompt
- [Runtime and Lifecycle](./runtime-and-lifecycle) — when and how the character is loaded
- [Configuration Reference](/configuration) — full `eliza.json` schema
