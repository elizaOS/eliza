/**
 * Resolves and opens Eliza Cloud management and the add-funds / credits
 * page the app links to when a dedicated-agent upgrade is refused for lack of
 * credits (HTTP 402). On mobile the Cloud view is not mounted in the thin
 * client, so this opens the hosted `cloud.eliza.app/cloud/billing` page in the
 * platform browser (Capacitor in-app browser / desktop bridge / new tab) via the
 * shared `openExternalUrl`. Kept tiny and side-effect-light so both the in-chat
 * boot-recovery conductor and the home provisioning widget share platform-aware
 * management links. Opening a page is never approval of a paid operation.
 */

import { normalizeCloudSiteUrl } from "@elizaos/shared/elizacloud";
import { getBootConfig } from "../config/boot-config";
import { isPersonalSharedElizaId } from "../utils/cloud-agent-base";
import { openExternalUrl } from "../utils/openExternalUrl";

/** The canonical hosted add-funds / credits console URL. */
export function cloudBillingConsoleUrl(cloudApiBase?: string): string {
  const cloudAppOrigin = normalizeCloudSiteUrl(
    cloudApiBase ?? getBootConfig().cloudApiBase,
  );
  return `${cloudAppOrigin}/cloud/billing`;
}

/** Open the billing console on the current platform. */
export function openCloudBillingConsole(
  cloudApiBase?: string,
): Promise<boolean> {
  return openExternalUrl(cloudBillingConsoleUrl(cloudApiBase));
}

/** Open the existing management/price-review surface; navigation never approves activation. */
export function openCloudAgentConsole(
  agentId: string,
  cloudApiBase?: string,
): Promise<boolean> {
  const cloudAppOrigin = normalizeCloudSiteUrl(
    cloudApiBase ?? getBootConfig().cloudApiBase,
  );
  // Rowless personal identities have a management card on the list, not a
  // UUID-backed detail route. Existing agents retain their exact target page.
  const path = isPersonalSharedElizaId(agentId)
    ? "/cloud/agents"
    : `/cloud/agents/${encodeURIComponent(agentId)}`;
  return openExternalUrl(`${cloudAppOrigin}${path}`);
}
