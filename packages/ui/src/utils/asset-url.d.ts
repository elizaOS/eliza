type AssetUrlResolveOptions = {
    currentUrl?: string;
    baseUrl?: string;
};
/**
 * Resolve an app public asset path into a URL safe across http(s), custom
 * schemes, and packaged file:// runtimes.
 */
export declare function resolveAppAssetUrl(assetPath: string, options?: AssetUrlResolveOptions): string;
/**
 * Resolve an API path (e.g. "/api/avatar/vrm") to a full URL reachable from
 * the renderer. In desktop shells the page origin is electrobun:// or
 * file://, so bare /api/... paths resolve to the SPA instead of the backend.
 *
 * Resolution order: boot `apiBase` → shell-injected `__ELIZAOS_API_BASE__` →
 * `sessionStorage` fallback. The boot config is the current client-owned
 * source of truth because `client.setBaseUrl()` updates it whenever the user
 * switches servers. Injection still beats stale session state from prior
 * sessions, but it must not override the active runtime target once the client
 * has changed it.
 */
export declare function resolveApiUrl(apiPath: string): string;
export {};
//# sourceMappingURL=asset-url.d.ts.map