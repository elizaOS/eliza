/**
 * Public barrel for the `@elizaos/agent` runtime module: re-exports the boot
 * orchestration (`eliza.ts`), the "eliza" plugin factory, plugin
 * collection/lifecycle/resolution, conversation compaction, owner-entity and
 * role helpers, release-channel policy, trajectory persistence/query, and the
 * version resolver. `plugin-resolver.ts` is re-exported by name rather than
 * `export *` so only the resolver entry points surface through this barrel.
 */
export * from "./advanced-capabilities-config.ts";
export * from "./agent-event-service.ts";
export * from "./conversation-compactor.ts";
export * from "./conversation-compactor.types.ts";
export * from "./eliza.ts";
export * from "./eliza-plugin.ts";
export * from "./first-run-names.ts";
export * from "./owner-entity.ts";
export * from "./plugin-collector.ts";
export * from "./plugin-lifecycle.ts";
export {
  type FailedPluginDetail,
  getLastFailedPluginDetails,
  getLastFailedPluginNames,
  resolvePlugins,
} from "./plugin-resolver.ts";
export * from "./plugin-types.ts";
export * from "./release-plugin-policy.ts";
export * from "./roles.ts";
export * from "./trajectory-internals.ts";
export * from "./trajectory-persistence.ts";
export * from "./trajectory-query.ts";
export * from "./version.ts";
