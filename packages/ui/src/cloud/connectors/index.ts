/**
 * Cloud connectors domain — public surface.
 *
 * These are the CLOUD-hosted connectors (OAuth-redirect + token-credential)
 * lifted from `@elizaos/cloud-frontend`. The domain:
 *
 * - registers a cloud route at `dashboard/settings/connections` via
 *   {@link registerCloudRoute} (import side-effect below), so the shell renders
 *   the connectors surface standalone;
 * - exports {@link CloudConnectorsSection} (the canonical port of the
 *   cloud-frontend `ConnectionsTab`) plus the individual connection components
 *   so Wave-3 settings wiring can mount the surface however it chooses;
 * - exports {@link registerCloudConnectorsSettingsSection} so the host can
 *   register the surface as a Settings section under the "agent" group WITHOUT
 *   this module deciding the settings IA at import time (that decision belongs
 *   to Wave-3, and the pinned `settings-section-meta` is owned elsewhere).
 *
 * Backend endpoints consumed (all same-origin `/api/*`, auth via steward
 * cookie on web + Bearer on native):
 *   - OAuth-redirect: `GET/POST/DELETE /api/v1/oauth/{connections,<platform>/initiate}`
 *   - Twilio:    `GET /api/v1/twilio/status`, `POST /api/v1/twilio/connect`, `DELETE /api/v1/twilio/disconnect`
 *   - Blooio:    `GET /api/v1/blooio/status`, `POST /api/v1/blooio/{connect,webhook-secret}`, `DELETE /api/v1/blooio/disconnect`
 *   - WhatsApp:  `GET /api/v1/whatsapp/status`, `POST /api/v1/whatsapp/connect`, `DELETE /api/v1/whatsapp/disconnect`
 *   - Telegram:  `GET /api/v1/telegram/status`, `POST /api/v1/telegram/connect`, `DELETE /api/v1/telegram/disconnect`
 *   - Discord:   `GET/POST /api/v1/discord/connections`, `PATCH/DELETE /api/v1/discord/connections/:id`, `GET /api/v1/dashboard` (character list)
 */

import { Plug } from "lucide-react";
import { registerSettingsSection } from "../../components/settings/settings-section-registry";
import { registerCloudRoute } from "../shell/cloud-route-registry";
import { CloudConnectorsSection } from "./CloudConnectorsSection";

export { BlooioConnection } from "./blooio-connection";
export { CloudConnectorsSection } from "./CloudConnectorsSection";
export { DiscordGatewayConnection } from "./discord-gateway-connection";
export { GoogleConnection } from "./google-connection";
export { MicrosoftConnection } from "./microsoft-connection";
export {
  type OAuthConnection,
  type OAuthProviderConfig,
  useOAuthConnections,
} from "./oauth-connection";
export { TelegramConnection } from "./telegram-connection";
export { TwilioConnection } from "./twilio-connection";
export { useConnectionStatus } from "./use-connection-status";
export { WhatsAppConnection } from "./whatsapp-connection";

/**
 * Stable id for the cloud connectors Settings section. Distinct from the
 * built-in local-process `connectors` section so the two coexist until the
 * planned active-server-kind branch unifies them.
 */
export const CLOUD_CONNECTORS_SECTION_ID = "cloud-connectors";

/**
 * Register the cloud connectors surface as a Settings section under the "agent"
 * group. Idempotent (the registry replaces by id). Call from the host's cloud
 * boot path; not invoked at import time so the settings IA stays the host's
 * decision.
 */
export function registerCloudConnectorsSettingsSection(): void {
  registerSettingsSection({
    id: CLOUD_CONNECTORS_SECTION_ID,
    label: "settings.sections.cloudConnectors.label",
    defaultLabel: "Cloud Connectors",
    icon: Plug,
    tone: "accent",
    hue: "accent",
    group: "agent",
    titleKey: "settings.sections.cloudConnectors.title",
    defaultTitle: "Cloud Connectors",
    Component: CloudConnectorsSection,
  });
}

// Register the standalone cloud route at import time. The cloud-frontend OAuth
// initiate flow redirects back to `/dashboard/settings?tab=connections`; this
// path keeps that deep link resolvable inside the app shell.
registerCloudRoute({
  path: "dashboard/settings/connections",
  element: CloudConnectorsSection,
  group: "dashboard",
});
