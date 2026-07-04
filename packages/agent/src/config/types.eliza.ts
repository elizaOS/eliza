/**
 * Compatibility re-export barrel that re-surfaces the full `@elizaos/shared`
 * public surface — the elizaOS config type definitions and companion helpers —
 * under this agent-scoped `config/` module path, so sibling `@elizaos/plugin-*`
 * packages and the app shell can import config types from a stable
 * `@elizaos/agent/config/*` path without depending on `@elizaos/shared` directly.
 */
export * from "@elizaos/shared";
