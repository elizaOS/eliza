/**
 * Plugin config catalog & registry.
 *
 * The implementation is owned by `@elizaos/shared/config/config-catalog` (the
 * single source of truth, also consumed by server-side config tooling). This
 * module re-exports it so the existing `@elizaos/ui` import paths
 * (`@elizaos/ui` root barrel, `@elizaos/ui/config`, and the relative
 * `../../config/config-catalog` imports under `components/config-ui/`) keep
 * resolving here without forking the ~1k-line engine.
 *
 * config-catalog imports only React (type-only) + zod + shared types, so it is
 * safe to pull into the browser bundle via this re-export.
 */
export * from "@elizaos/shared/config/config-catalog";
