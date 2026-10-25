/**
 * Cloud connectors surface (Messaging & Communication + Channels groups).
 *
 * These are the CLOUD-hosted connectors (OAuth-redirect + token-credential),
 * distinct from the local-process `ConnectorsSection`.
 */

"use client";

import {
  ConnectionStatusNotice,
  ConnectionStatusProvider,
} from "../../cloud-ui/components/connection-card";
import {
  SettingsGroup,
  SettingsStack,
} from "../../components/settings/settings-layout";
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
    <ConnectionStatusProvider>
      <SettingsStack data-testid="cloud-connectors-section">
        <ConnectionStatusNotice />
        <SettingsGroup
          title={t("cloud.connectionsTab.servicesTitle", {
            defaultValue: "Services",
          })}
          description={t("cloud.connectionsTab.servicesDescription", {
            defaultValue: "Email, calendar, phone, and business messaging.",
          })}
        >
          <GoogleConnection />
          <MicrosoftConnection />
          <TwilioConnection />
          <BlooioConnection />
          <WhatsAppConnection />
        </SettingsGroup>

        <SettingsGroup
          title={t("cloud.connectionsTab.botChannelsTitle", {
            defaultValue: "Bot channels",
          })}
          description={t("cloud.connectionsTab.botChannelsDescription", {
            defaultValue: "Managed Discord and Telegram gateways.",
          })}
        >
          <DiscordGatewayConnection />
          <TelegramConnection />
        </SettingsGroup>
      </SettingsStack>
    </ConnectionStatusProvider>
  );
}

export default CloudConnectorsSection;
