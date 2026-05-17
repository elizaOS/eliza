/**
 * First-party sensitive-request channel adapters and their composed
 * registration helper.
 *
 * Adapter coverage (Wave A):
 * - `dm` — provided by `plugin-discord` and (future) other connector plugins.
 *   Not registered here.
 * - `owner_app_inline` — Eliza app private chat inline form.
 * - `cloud_authenticated_link` — cloud-hosted page (cloud paired).
 * - `tunnel_authenticated_link` — local tunnel-served page.
 * - `public_link` — unauthenticated payment URL for any-payer payments.
 * - `instruct_dm_only` — text-only "no link / no form" fallback.
 */
export { cloudLinkSensitiveRequestAdapter, createCloudLinkSensitiveRequestAdapter, } from "./cloud-link-adapter";
export { instructDmOnlySensitiveRequestAdapter } from "./instruct-dm-only-adapter";
export { ownerAppInlineSensitiveRequestAdapter } from "./owner-app-inline-adapter";
export { publicLinkSensitiveRequestAdapter } from "./public-link-adapter";
export { createTunnelLinkSensitiveRequestAdapter, tunnelLinkSensitiveRequestAdapter, } from "./tunnel-link-adapter";
/**
 * Registers app-core's first-party sensitive-request delivery adapters with
 * the runtime's `SensitiveRequestDispatchRegistry` service. No-op when the
 * registry service is not present (e.g. in unit tests that don't boot the
 * full runtime).
 */
export declare function registerCoreSensitiveRequestAdapters(runtime: unknown): void;
//# sourceMappingURL=index.d.ts.map