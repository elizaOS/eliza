import type { SensitiveRequestDeliveryAdapter } from "@elizaos/core";
export interface CloudLinkAdapterDeps {
  /**
   * Resolves the cloud site base URL (e.g. `https://www.elizacloud.ai`) when
   * the user has paired Eliza Cloud. Returns `null` when cloud is not
   * configured. Defaults to a runtime-aware resolver that consults
   * `runtime.getSetting("ELIZAOS_CLOUD_API_KEY")` /
   * `runtime.getSetting("ELIZAOS_CLOUD_BASE_URL")` with `process.env`
   * fallbacks.
   */
  resolveCloudBase?: (runtime: unknown) => string | null;
}
export declare function createCloudLinkSensitiveRequestAdapter(
  deps?: CloudLinkAdapterDeps,
): SensitiveRequestDeliveryAdapter;
export declare const cloudLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter;
//# sourceMappingURL=cloud-link-adapter.d.ts.map
