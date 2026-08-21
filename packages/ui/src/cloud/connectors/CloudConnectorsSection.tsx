/**
 * Cloud connectors surface (Messaging & Communication + Channels groups).
 *
 * These are the CLOUD-hosted connectors (OAuth-redirect + token-credential),
 * distinct from the local-process `ConnectorsSection`.
 */

"use client";

import { DashboardSection } from "../../cloud-ui/components/brand/dashboard-section";
import { useCloudT } from "../shell/CloudI18nProvider";
import { BlooioConnection } from "./blooio-connection";
import { DiscordGatewayConnection } from "./discord-gateway-connection";
import { GoogleConnection } from "./google-connection";
import { MicrosoftConnection } from "./microsoft-connection";
import { SharedAgentFirstFiveMinutes } from "./SharedAgentFirstFiveMinutes";
import { TelegramConnection } from "./telegram-connection";
import { TwilioConnection } from "./twilio-connection";
import { WhatsAppConnection } from "./whatsapp-connection";

export function CloudConnectorsSection() {
  const t = useCloudT();
  return (
    <div className="space-y-8">
      <SharedAgentFirstFiveMinutes />

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
          <div id="twilio-connection" className="scroll-mt-6">
            <TwilioConnection />
          </div>
          <div id="blooio-connection" className="scroll-mt-6">
            <BlooioConnection />
          </div>
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
          <div id="telegram-connection" className="scroll-mt-6">
            <TelegramConnection />
          </div>
        </div>
      </div>
    </div>
  );
}

export default CloudConnectorsSection;
