/**
 * Cloud connectors upsell — shown in the Settings "Cloud Connectors" section
 * when Eliza Cloud is NOT connected.
 *
 * This component reads the app store (`useAppSelectorShallow`) and therefore may
 * ONLY be mounted under `<AppProvider>`. The Settings section adapter
 * ({@link CloudConnectorsSettingsBody}) renders inside the app shell, which
 * supplies that provider.
 */

"use client";

import { Bot, Cloud, MessageSquare, Plug, RadioTower } from "lucide-react";
import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../components/settings/settings-layout";
import { Button } from "../../components/ui/button";
import { useAppSelectorShallow } from "../../state";
import { CloudConnectorsSection } from "./CloudConnectorsSection";

const CLOUD_CONNECTOR_FEATURES = [
  {
    icon: RadioTower,
    key: "alwaysOnGateway",
    label: "Always-on gateway hosting",
    description:
      "Keep Discord, Telegram, WhatsApp, Twilio, Google, and Microsoft routes online without depending on this Mac staying awake.",
  },
  {
    icon: Bot,
    key: "agentRouting",
    label: "Agent routing",
    description:
      "Route each cloud connection to the right hosted agent or local app target as your setup grows.",
  },
  {
    icon: MessageSquare,
    key: "sharedSurfaces",
    label: "Shared messaging surfaces",
    description:
      "Use managed OAuth, webhooks, and bot gateways for teams and devices that cannot reach your local machine.",
  },
] as const;

function CloudConnectorsUpsell(): React.JSX.Element {
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
        error instanceof Error
          ? error.message
          : t("settings.cloudConnectorsUpsell.loginError", {
              defaultValue: "Could not start Cloud login.",
            }),
        "error",
        5000,
      );
    });
  }, [handleCloudLogin, setActionNotice, t]);

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
            key={feature.key}
            icon={feature.icon}
            label={t(
              `settings.cloudConnectorsUpsell.features.${feature.key}.label`,
              {
                defaultValue: feature.label,
              },
            )}
            description={t(
              `settings.cloudConnectorsUpsell.features.${feature.key}.description`,
              { defaultValue: feature.description },
            )}
          />
        ))}
      </SettingsGroup>
    </SettingsStack>
  );
}

/**
 * Settings-section body: when Eliza Cloud is connected, render the canonical
 * connectors surface; otherwise render the upsell. This branch reads the app
 * store and so is only valid under `<AppProvider>` (the app-shell Settings
 * view).
 */
export function CloudConnectorsSettingsBody(): React.JSX.Element {
  const elizaCloudConnected = useAppSelectorShallow(
    (s) => s.elizaCloudConnected,
  );
  if (!elizaCloudConnected) {
    return <CloudConnectorsUpsell />;
  }
  return <CloudConnectorsSection />;
}

export default CloudConnectorsSettingsBody;
