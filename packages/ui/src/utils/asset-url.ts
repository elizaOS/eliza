/**
 * Re-exports the shared API/app asset URL resolvers so UI callers use one
 * canonical origin-aware helper.
 */
export {
  resolveApiUrl,
  resolveAppAssetUrl,
} from "@elizaos/ui/utils/asset-url";
