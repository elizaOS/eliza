/**
 * Re-exports the shared API/app asset URL resolvers so UI callers use one
 * canonical origin-aware helper.
 */
export {
  resolveApiUrl,
  resolveAppAssetUrl,
} from "@elizaos/shared/utils/asset-url";
