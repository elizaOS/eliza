# Retired patches

Historical record of patches that once lived in
`eliza/packages/app-core/scripts/patch-deps.mjs` (or
`eliza/packages/app-core/scripts/lib/patch-bun-exports.mjs`) and have
since been removed because the upstream fix shipped and the workaround
is no longer needed.

Kept as a reference when bisecting old bugs — you may encounter the
patch name in logs or old branches and want to know whether it was
retired deliberately.

## From `patch-deps.mjs`

| Patch | Retired because |
|---|---|
| `patchElizaCoreMemoryStorageStub` | `requireStorage` refactored out of `@elizaos/core`. |
| `patchElizaCoreStreamingTtsHandlerGuard` | TTS guard now present in `@elizaos/core` source. |
| `patchElizaCoreStreamingRetryPlaceholder` | Retry-placeholder code path removed from `@elizaos/core`. |
| `patchPluginSqlCountMemoriesSignature` | `@elizaos/plugin-sql`'s `countMemories` supports both call signatures. |
| `patchGroqSdkVersion` | `@elizaos/plugin-groq` uses `workspace:*`; no nested `@ai-sdk/groq` to pin. |
| `patchElizaCoreNodeTypes` | Workspace builds of `@elizaos/core` include types directly. |
| Action parsing fix | Shipped upstream in `@elizaos/core@2.0.0-alpha.106` (PR #6661 — `parseKeyValueXml` preserves raw XML string for `<actions>` content). |

## Contribution note

When retiring a patch, delete the function and its call site, and add
a one-line entry here with the upstream version / PR that made it
unnecessary. Do **not** leave memorial comments inline in the patch
file — they become noise and make the active patch set harder to
audit.
