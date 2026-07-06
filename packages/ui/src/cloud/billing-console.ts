/**
 * Resolves and opens the Eliza Cloud billing console — the add-funds / credits
 * page the app links to when a dedicated-agent upgrade is refused for lack of
 * credits (HTTP 402). On mobile the cloud dashboard is not mounted in the thin
 * client, so this opens the hosted `<cloudApiBase>/dashboard/billing` page in the
 * platform browser (Capacitor in-app browser / desktop bridge / new tab) via the
 * shared `openExternalUrl`. Kept tiny and side-effect-light so both the in-chat
 * boot-recovery conductor and the home provisioning widget reuse one add-credits
 * path instead of hand-building the URL twice.
 */

import { getBootConfig } from "../config/boot-config";
import { openExternalUrl } from "../utils/openExternalUrl";

const DEFAULT_CLOUD_API_BASE = "https://elizacloud.ai";

/** The canonical hosted add-funds / credits console URL. */
export function cloudBillingConsoleUrl(cloudApiBase?: string): string {
  const base = (
    cloudApiBase ??
    getBootConfig().cloudApiBase ??
    DEFAULT_CLOUD_API_BASE
  ).replace(/\/+$/, "");
  return `${base}/dashboard/billing`;
}

/** Open the billing console on the current platform. */
export function openCloudBillingConsole(cloudApiBase?: string): Promise<void> {
  return openExternalUrl(cloudBillingConsoleUrl(cloudApiBase));
}
