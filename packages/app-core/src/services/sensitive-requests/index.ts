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

import { logger, type SensitiveRequestDeliveryAdapter } from "@elizaos/core";
import { cloudLinkSensitiveRequestAdapter } from "./cloud-link-adapter";
import { instructDmOnlySensitiveRequestAdapter } from "./instruct-dm-only-adapter";
import { ownerAppInlineSensitiveRequestAdapter } from "./owner-app-inline-adapter";
import { publicLinkSensitiveRequestAdapter } from "./public-link-adapter";
import { tunnelLinkSensitiveRequestAdapter } from "./tunnel-link-adapter";

export {
  cloudLinkSensitiveRequestAdapter,
  createCloudLinkSensitiveRequestAdapter,
} from "./cloud-link-adapter";
export { instructDmOnlySensitiveRequestAdapter } from "./instruct-dm-only-adapter";
export { ownerAppInlineSensitiveRequestAdapter } from "./owner-app-inline-adapter";
export { publicLinkSensitiveRequestAdapter } from "./public-link-adapter";
export {
  createTunnelLinkSensitiveRequestAdapter,
  tunnelLinkSensitiveRequestAdapter,
} from "./tunnel-link-adapter";

interface RegistryLike {
  register(adapter: SensitiveRequestDeliveryAdapter): void;
}

function isRegistry(value: unknown): value is RegistryLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { register?: unknown }).register === "function"
  );
}

/**
 * Registers app-core's first-party sensitive-request delivery adapters with
 * the runtime's `SensitiveRequestDispatchRegistry` service. No-op when the
 * registry service is not present (e.g. in unit tests that don't boot the
 * full runtime).
 */
export function registerCoreSensitiveRequestAdapters(runtime: unknown): void {
  const registry = (
    runtime as { getService?: (n: string) => unknown }
  ).getService?.("SensitiveRequestDispatchRegistry");
  if (!isRegistry(registry)) {
    logger.debug(
      "[sensitive-requests] dispatch registry service not present; skipping adapter registration",
    );
    return;
  }
  registry.register(ownerAppInlineSensitiveRequestAdapter);
  registry.register(cloudLinkSensitiveRequestAdapter);
  registry.register(tunnelLinkSensitiveRequestAdapter);
  registry.register(instructDmOnlySensitiveRequestAdapter);
  registry.register(publicLinkSensitiveRequestAdapter);
  logger.debug(
    "[sensitive-requests] registered 5 first-party delivery adapters",
  );
}
