/**
 * Cloud connectors domain — the CLOUD-hosted connectors (OAuth-redirect +
 * token-credential). Mounted as the `cloud-connectors` Settings section, which
 * shows an upsell while Cloud is disconnected and the connectors surface when
 * it is connected. Legacy `/dashboard/settings?tab=connections` deep links
 * (the OAuth-callback return target) resolve here via the CloudRouterShell
 * compat redirect.
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
import { createElement } from "react";
import { registerSettingsSection } from "../../components/settings/settings-section-registry";
import { CloudSettingsSectionShell } from "../settings/CloudSettingsSectionShell";
import { CloudConnectorsSettingsBody } from "./CloudConnectorsUpsell";

/**
 * Stable id for the cloud connectors Settings section. Distinct from the
 * built-in local-process `connectors` section so the two coexist.
 */
export const CLOUD_CONNECTORS_SECTION_ID = "cloud-connectors";

/**
 * Settings-section adapter for the cloud connectors surface. Settings sections
 * render inside the app-shell settings registry (under AppProvider), so this
 * adapter provides the cloud stack (query/i18n/auth) before mounting
 * {@link CloudConnectorsSettingsBody}, which reads the app store to show the
 * upsell when Cloud is not connected and the connectors surface when it is.
 */
export function CloudConnectorsSettingsSection(): React.JSX.Element {
  return createElement(
    CloudSettingsSectionShell,
    null,
    createElement(CloudConnectorsSettingsBody),
  );
}

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
    Component: CloudConnectorsSettingsSection,
  });
}
