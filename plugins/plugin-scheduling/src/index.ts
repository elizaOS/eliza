// The spine barrel (scheduled-task/index) already re-exports AnchorRegistry +
// createAnchorRegistry from consolidation-policy, so surface only the
// anchor-registry's own symbols here to avoid a duplicate-export collision.
export {
  __resetAnchorRegistryForTests,
  APP_LIFEOPS_ANCHORS,
  getAnchorRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
} from "./anchors/anchor-registry.ts";
export type { DispatchResult } from "./dispatch-types.ts";
export { schedulingPlugin } from "./plugin.ts";
export * from "./scheduled-task/index.ts";
