/**
 * Cloud connectors surface — the canonical port of the cloud-frontend
 * `ConnectionsTab` (Messaging & Communication + Channels groups).
 *
 * These are the CLOUD-hosted connectors (OAuth-redirect + token-credential),
 * distinct from the local-process `ConnectorsSection`. The surface is designed
 * so it can later branch by active-server kind; for now it always renders the
 * cloud variant.
 */

"use client";

import { DashboardSection } from "../../cloud-ui/components/brand/dashboard-section";
import { useCloudT } from "../shell/CloudI18nProvider";
import { BlooioConnection } from "./blooio-connection";
import { DiscordGatewayConnection } from "./discord-gateway-connection";
import { GoogleConnection } from "./google-connection";
import { MicrosoftConnection } from "./microsoft-connection";
import { TelegramConnection } from "./telegram-connection";
import { TwilioConnection } from "./twilio-connection";
import { WhatsAppConnection } from "./whatsapp-connection";

export function CloudConnectorsSection() {
  const t = useCloudT();
  return (
    <div className="space-y-8">
      {/* Messaging & Communication Section */}
      <div className="space-y-4">
        <DashboardSection
          label={t("cloud.connectionsTab.connectionsLabel", {
            defaultValue: "Connections",
          })}
          title={t("cloud.connectionsTab.messagingTitle", {
            defaultValue: "Messaging & Communication",
          })}
        />

        <div className="grid gap-4">
          <GoogleConnection />
          <MicrosoftConnection />
          <TwilioConnection />
          <BlooioConnection />
          <WhatsAppConnection />
        </div>
      </div>

      {/* Social Media Section */}
      <div className="space-y-4">
        <DashboardSection
          label={t("cloud.connectionsTab.channelsLabel", {
            defaultValue: "Channels",
          })}
          title={t("cloud.connectionsTab.socialTitle", {
            defaultValue: "Social Media Connections",
          })}
        />

        <div className="grid gap-4">
          <DiscordGatewayConnection />
          <TelegramConnection />
        </div>
      </div>
    </div>
  );
}

export default CloudConnectorsSection;
