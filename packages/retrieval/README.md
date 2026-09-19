# Retrieval

Optional, dependency-free search algorithms shared by storage adapters and application features. The root barrel exports BM25/tokenization, hybrid result merging, message search and `rerankMemories`. There is no runtime, database, provider, configuration or network dependency.

Core delegates `searchMemories` to its registered adapter. SQL and both in-memory adapters apply authorization and scope before vector ranking and pagination, then use `rerankMemories` on that result page when a query is supplied. Keyword matches lead; semantic-only and attachment-only results remain in their original relative order. No query preserves vector order. Raw vector search remains available on adapters.

Consumers previously importing search algorithms from `@elizaos/core` should import them from `@elizaos/retrieval`. Custom adapters own query ranking under the same `IDatabaseAdapter.searchMemories` contract; they may use this helper or their backend's implementation. `AgentRuntime.rerankMemories` is removed; explicit reranking uses the exported pure helper.

Run `bun run --cwd packages/retrieval test`, `typecheck` and `build`. Builds produce one ESM barrel and one bundled declaration in `dist/`. This package is optional and is not a production dependency of core. The extraction removes implementation from the kernel; it is a code move, not a repository-wide deletion claim.
