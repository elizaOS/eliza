/**
 * Compatibility re-export. The companion scene config context object +
 * `useCompanionSceneConfig` hook live in `./CompanionSceneConfigContext.hooks`
 * so importers stay React Fast Refresh-compatible. Kept so the `state` barrel
 * resolves unchanged.
 */
export {
  type CompanionSceneConfig,
  CompanionSceneConfigCtx,
  useCompanionSceneConfig,
} from "./CompanionSceneConfigContext.hooks";
