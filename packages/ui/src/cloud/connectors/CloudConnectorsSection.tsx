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

import { Bot, Cloud, MessageSquare, Plug, RadioTower } from "lucide-react";
import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import { DashboardSection } from "../../cloud-ui/components/brand/dashboard-section";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../components/settings/settings-layout";
import { Button } from "../../components/ui/button";
import { useAppSelectorShallow } from "../../state";
import { useCloudT } from "../shell/CloudI18nProvider";
import { BlooioConnection } from "./blooio-connection";
import { DiscordGatewayConnection } from "./discord-gateway-connection";
import { GoogleConnection } from "./google-connection";
import { MicrosoftConnection } from "./microsoft-connection";
import { TelegramConnection } from "./telegram-connection";
import { TwilioConnection } from "./twilio-connection";
import { WhatsAppConnection } from "./whatsapp-connection";

const CLOUD_CONNECTOR_FEATURES = [
  {
    icon: RadioTower,
    label: "Always-on gateway hosting",
    description:
      "Keep Discord, Telegram, WhatsApp, Twilio, Google, and Microsoft routes online without depending on this Mac staying awake.",
  },
  {
    icon: Bot,
    label: "Agent routing",
    description:
      "Route each cloud connection to the right hosted agent or local app target as your setup grows.",
  },
  {
    icon: MessageSquare,
    label: "Shared messaging surfaces",
    description:
      "Use managed OAuth, webhooks, and bot gateways for teams and devices that cannot reach your local machine.",
  },
] as const;

function CloudConnectorsUpsell() {
  const {
    elizaCloudConnected,
    elizaCloudLoginBusy,
    handleCloudLogin,
    setActionNotice,
    t,
  } = useAppSelectorShallow((s) => ({
    elizaCloudConnected: s.elizaCloudConnected,
    elizaCloudLoginBusy: s.elizaCloudLoginBusy,
    handleCloudLogin: s.handleCloudLogin,
    setActionNotice: s.setActionNotice,
    t: s.t,
  }));

  const handleConnect = useCallback(() => {
    void handleCloudLogin().catch((error) => {
      setActionNotice(
        error instanceof Error ? error.message : "Could not start Cloud login.",
        "error",
        5000,
      );
    });
  }, [handleCloudLogin, setActionNotice]);

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "cloud-connectors-connect-cloud",
    role: "button",
    label: "Connect Eliza Cloud",
    group: "cloud-connectors",
    status: elizaCloudConnected ? "connected" : "available",
    onActivate: elizaCloudLoginBusy ? undefined : handleConnect,
  });

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.cloudConnectorsUpsell.title", {
          defaultValue: "Hosted connector gateways",
        })}
        description={t("settings.cloudConnectorsUpsell.description", {
          defaultValue:
            "Local connectors stay available in the regular Connectors tab. Cloud Connectors unlock hosted OAuth and bot gateways when you want messaging to keep working beyond this machine.",
        })}
        action={
          <Button
            ref={ref}
            size="sm"
            onClick={handleConnect}
            disabled={elizaCloudLoginBusy}
            {...agentProps}
          >
            <Cloud className="h-4 w-4" aria-hidden />
            {elizaCloudLoginBusy
              ? t("settings.cloudConnectorsUpsell.connecting", {
                  defaultValue: "Connecting...",
                })
              : t("settings.cloudConnectorsUpsell.connectCta", {
                  defaultValue: "Connect Cloud",
                })}
          </Button>
        }
      >
        <SettingsRow
          icon={Plug}
          label={t("settings.cloudConnectorsUpsell.localModeLabel", {
            defaultValue: "Cloud is not connected",
          })}
          description={t(
            "settings.cloudConnectorsUpsell.localModeDescription",
            {
              defaultValue:
                "You can keep using local Discord, Telegram, Slack, iMessage, Signal, and WhatsApp connectors without Cloud.",
            },
          )}
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.cloudConnectorsUpsell.unlockTitle", {
          defaultValue: "What Cloud Connectors unlock",
        })}
      >
        {CLOUD_CONNECTOR_FEATURES.map((feature) => (
          <SettingsRow
            key={feature.label}
            icon={feature.icon}
            label={feature.label}
            description={feature.description}
          />
        ))}
      </SettingsGroup>
    </SettingsStack>
  );
}

export function CloudConnectorsSection() {
  const t = useCloudT();
  const elizaCloudConnected = useAppSelectorShallow(
    (s) => s.elizaCloudConnected,
  );

  if (!elizaCloudConnected) {
    return <CloudConnectorsUpsell />;
  }

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
