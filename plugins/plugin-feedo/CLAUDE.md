# @elizaos/plugin-feedo

Adds decentralized End-to-End Encrypted (E2EE) long-term memory for ElizaOS using the Feedo Protocol.

## Purpose / role

The default export registers `feedoPlugin`, which contains:
- `storeFeedoAction`: Saves essential conversational context, user preferences, or instructions into the decentralized Feedo Memory Network using `indexPrivateDocument`.
- `feedoProvider`: Automatically retrieves relevant memories from the Feedo Network and injects them into the agent's context during evaluation.

This plugin ensures that memory is stored securely (E2EE) off-host, solving the problem of persistent, cross-session memory without relying on centralized plaintext databases.

## Plugin surface

| Kind | Name | What it does |
|------|------|-------------|
| Provider | `feedoProvider` | Extracts the user's message text and performs a semantic search against Feedo's decentralized network. Returns formatted context memories. |
| Action | `STORE_IN_FEEDO` | Saves important information or long-term context to the Feedo Memory Network. Uses `indexPrivateDocument` to ensure E2EE. |

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
pnpm run --cwd plugins/plugin-feedo build       # tsup ESM + .d.ts
pnpm run --cwd plugins/plugin-feedo lint        # biome check src/
pnpm run --cwd plugins/plugin-feedo typecheck   # tsc --noEmit
pnpm run --cwd plugins/plugin-feedo test        # vitest run
```

## Config / env vars

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEEDO_USAGE_KEY` | Yes (to be functional) | — | Feedo network usage key. You can generate a free testnet usage key at https://feedo.ink. |
| `FEEDO_AGENT_DID` | Yes (to be functional) | — | The decentralized identity string for the agent. Used to namespace and encrypt memories. |

Read via `runtime.getSetting()` inside the Provider and Action validation/handlers.

## Conventions / gotchas

- **Graceful degradation.** The Provider returns `{ text: "" }` and Action returns `undefined` if credentials are not configured, rather than throwing exceptions, so the agent can continue functioning without long-term memory if the plugin is installed but unconfigured.
- **E2EE Storage only.** The `STORE_IN_FEEDO` action explicitly uses `client.search.indexPrivateDocument()` instead of `indexDocument()`. This ensures that data is encrypted on the client before being broadcasted to the decentralized network.
- **Provider propagation.** The provider propagates the `ProviderExecutionContext.signal` (AbortSignal) by checking `context?.signal?.aborted` before proceeding with the SDK request.
- **Strictly Pinned SDK.** The `feedo-protocol-sdk` dependency is strictly pinned in `package.json` to prevent arbitrary upstream changes from running inside the agent process.
- For repo-wide conventions (logger-only, ESM modules, naming, architecture rules) see the root `CLAUDE.md`.

## Verification

Run the package's relevant build, typecheck, lint, and test commands (`UNIT_TEST_RESULTS.md` and `E2E_RESULTS.md` document the current verified behavior).
