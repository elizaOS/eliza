# @elizaos/plugin-feedo

Adds decentralized private long-term memory for ElizaOS using the Feedo Protocol.

## Purpose / role

The default export registers `feedoPlugin`, which contains:
- `storeFeedoAction`: Saves essential conversational context, user preferences, or instructions into the decentralized Feedo Memory Network using `indexPrivateDocument`.
- `feedoProvider`: Automatically retrieves relevant memories from the Feedo Network and injects them into the agent's context during evaluation.

This plugin ensures that memory is stored privately (encrypted at rest) off-host, solving the problem of persistent, cross-session memory without relying on centralized databases.

## Plugin surface

| Kind | Name | What it does |
|------|------|-------------|
| Provider | `feedoProvider` | Extracts the user's message text and performs a semantic search against Feedo's decentralized network. Returns formatted context memories scoped to the `roomId`. |
| Action | `STORE_IN_FEEDO` | Saves important information or long-term context to the Feedo Memory Network. Uses `indexPrivateDocument` with `roomId` namespaces. |

No standalone services or evaluators are registered.

## Layout

```
src/
  index.ts                     Plugin object (feedoPlugin). Entry point.
  actions/
    storeFeedo.ts              STORE_IN_FEEDO action implementation. Uses feedo-protocol-sdk.
  providers/
    feedoProvider.ts           feedoProvider implementation. Retrieves context via SDK.
```

## Commands

All scripts run from the plugin root:

```bash
bun run --cwd plugins/plugin-feedo build       # tsup ESM + .d.ts
bun run --cwd plugins/plugin-feedo lint        # biome check src/
bun run --cwd plugins/plugin-feedo typecheck   # tsc --noEmit
bun run --cwd plugins/plugin-feedo test        # vitest run
```

## Config / env vars

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEEDO_USAGE_KEY` | Yes (to be functional) | — | Feedo network usage key. You can generate a free testnet usage key at https://feedo.ink. |
| `FEEDO_AGENT_DID` | Yes (to be functional) | — | The decentralized identity string for the agent. Used to namespace and encrypt memories. |

Read via `runtime.getSetting()` inside the Provider and Action validation/handlers.

## Conventions / gotchas

- **Graceful degradation.** The Provider returns `{ text: "" }` and Action returns `undefined` if credentials are not configured, rather than throwing exceptions.
- **Private Storage.** The `STORE_IN_FEEDO` action explicitly uses `client.search.indexPrivateDocument()` instead of `indexDocument()`. Data is encrypted at rest.
- **Tenant boundaries.** Context searching and indexing are bounded by the `namespace` field, set to the `message.roomId`, preventing cross-user data leakage.
- **Provider propagation.** The provider propagates the `ProviderExecutionContext.signal` (AbortSignal) by wrapping the SDK call in a `Promise.race` with an abort promise.
- **Strictly Pinned SDK.** The `feedo-protocol-sdk` dependency is strictly pinned in `package.json` to prevent arbitrary upstream changes.
- For repo-wide conventions (logger-only, ESM modules, naming, architecture rules) see the root `CLAUDE.md`.
