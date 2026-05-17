"use client";

import { DashboardSection } from "@elizaos/ui";
import { BlooioConnection } from "../blooio-connection";
import { DiscordGatewayConnection } from "../discord-gateway-connection";
import { GoogleConnection } from "../google-connection";
import { MicrosoftConnection } from "../microsoft-connection";
import { TelegramConnection } from "../telegram-connection";
import { TwilioConnection } from "../twilio-connection";
import { WhatsAppConnection } from "../whatsapp-connection";

export function ConnectionsTab() {
  return (
    <div className="space-y-8">
      {/* Messaging & Communication Section */}
      <div className="space-y-4">
        <DashboardSection
          label="Connections"
          title="Messaging & Communication"
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
        <DashboardSection label="Channels" title="Social Media Connections" />

        <div className="grid gap-4">
          <DiscordGatewayConnection />
          <TelegramConnection />
        </div>
      </div>
    </div>
  );
}
