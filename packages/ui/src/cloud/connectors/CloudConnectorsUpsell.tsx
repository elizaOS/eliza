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

import { Cloud, Plug, RadioTower } from "lucide-react";
import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../components/settings/settings-layout";
import { Button } from "../../components/ui/button";
import { useAppSelectorShallow } from "../../state";
import { claimCloudLoginWindow } from "../../state/cloud-login-launch";
import { CloudConnectorsSection } from "./CloudConnectorsSection";

function CloudConnectorsUpsell(): React.JSX.Element {
  const {
    elizaCloudConnected,
    elizaCloudLoginBusy,
    handleInteractiveCloudLogin,
    setActionNotice,
    t,
  } = useAppSelectorShallow((s) => ({
    elizaCloudConnected: s.elizaCloudConnected,
    elizaCloudLoginBusy: s.elizaCloudLoginBusy,
    handleInteractiveCloudLogin: s.handleInteractiveCloudLogin,
    setActionNotice: s.setActionNotice,
    t: s.t,
  }));

  const handleConnect = useCallback(() => {
    // Pre-open the popup synchronously inside the click's user activation.
    claimCloudLoginWindow();
    void handleInteractiveCloudLogin().catch((error) => {
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
  }, [handleInteractiveCloudLogin, setActionNotice, t]);

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
          defaultValue: "Connect Eliza Cloud",
        })}
        description={t("settings.cloudConnectorsUpsell.description", {
          defaultValue:
            "Run OAuth, bot, and webhook gateways outside this device.",
        })}
        action={
          <Button
            ref={ref}
            size="sm"
            onClick={handleConnect}
            disabled={elizaCloudLoginBusy}
            {...agentProps}
          >
            <Cloud className="size-4" aria-hidden />
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
          icon={RadioTower}
          label={t("settings.cloudConnectorsUpsell.hostedLabel", {
            defaultValue: "Hosted gateways",
          })}
          description={t("settings.cloudConnectorsUpsell.hostedDescription", {
            defaultValue:
              "Keep supported connections online when this device sleeps.",
          })}
        />
        <SettingsRow
          icon={Plug}
          label={t("settings.cloudConnectorsUpsell.localModeLabel", {
            defaultValue: "Local connectors stay available",
          })}
          description={t(
            "settings.cloudConnectorsUpsell.localModeDescription",
            {
              defaultValue: "Use Connectors without signing in to Cloud.",
            },
          )}
        />
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
