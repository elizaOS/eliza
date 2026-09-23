/**
 * Backwards-compatibility shim for the curated app/plugin/connector registry.
 *
 * The first-party curated registry (schema, loader, entries, and the runtime
 * registration overlay) moved to `@elizaos/shared/catalog`. This re-export
 * keeps the `@elizaos/app-core/registry` subpath — and the `@elizaos/app-core`
 * barrel re-exports — stable for existing consumers (plugin-registry,
 * plugin-capacitor-bridge, app-core's own catalog/eliza/vault-bootstrap).
 *
 * New code should import directly from `@elizaos/shared/catalog`.
 */
export * from "@elizaos/shared/catalog";
