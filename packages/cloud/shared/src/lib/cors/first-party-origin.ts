/**
 * Defines the Cloud browser origins allowed to use cookie or native
 * credentials across the API and dedicated-agent router boundaries.
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared/elizacloud/domain-contract";

import {
  APP_SCHEME_ORIGIN_RE,
  CAPACITOR_WEBVIEW_ORIGIN,
  isLocalDevLoopbackOrigin,
} from "../cors-constants";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

const STATIC_ALLOWED_ORIGINS = new Set<string>([
  ...Object.values(ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    contract.marketingOrigin,
    contract.cloudAppOrigin,
    contract.cloudApiOrigin,
  ]),
  `https://www.${new URL(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin).hostname}`,
  ...Object.values(LEGACY_ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    ...contract.marketingHostnames.map((host) => `https://${host}`),
    ...contract.cloudAppHostnames.map((host) => `https://${host}`),
    ...contract.cloudApiHostnames.map((host) => `https://${host}`),
  ]),
  // Exact develop branch alias for staging QA. Do not add a broad *.pages.dev
  // wildcard here; session-capable routes must remain first-party-only.
  "https://develop.eliza-app.pages.dev",
  "https://elizaos.ai",
  "https://www.elizaos.ai",
  "https://os.elizacloud.ai",
  "https://os.eliza.app",
  "https://eliza.ai",
  "https://www.eliza.ai",
]);

/** Whether an origin may receive credentialed browser responses. */
export function isFirstPartyOrigin(origin: string): boolean {
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  if (origin === CAPACITOR_WEBVIEW_ORIGIN || APP_SCHEME_ORIGIN_RE.test(origin)) {
    return true;
  }
  if (isLocalDevLoopbackOrigin(origin)) {
    return getCloudAwareEnv().ENVIRONMENT !== "production";
  }
  return false;
}
