import type { SensitiveRequestDeliveryAdapter } from "@elizaos/core";
export interface TunnelStatus {
    active: boolean;
    url?: string | null;
}
export interface TunnelLinkAdapterDeps {
    /**
     * Resolves the active tunnel base URL. Mirrors the helper used by
     * `packages/app-core/src/api/sensitive-request-routes.ts` which queries
     * `runtime.getService("tunnel")` for `getStatus()` / `isActive()` /
     * `getUrl()`. Returns `null` when no tunnel is active.
     */
    getTunnelStatus?: (runtime: unknown) => TunnelStatus | null;
}
export declare function createTunnelLinkSensitiveRequestAdapter(deps?: TunnelLinkAdapterDeps): SensitiveRequestDeliveryAdapter;
export declare const tunnelLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter;
//# sourceMappingURL=tunnel-link-adapter.d.ts.map