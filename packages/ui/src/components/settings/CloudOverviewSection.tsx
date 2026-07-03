import {
  Bot,
  Cloud,
  CreditCard,
  KeyRound,
  Plug,
  Rocket,
  Store,
} from "lucide-react";
import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import { useAppSelectorShallow } from "../../state";
import { Button } from "../ui/button";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

const CLOUD_FEATURES = [
  {
    icon: Plug,
    label: "Hosted connectors",
    description:
      "Run Discord, Telegram, Twilio, WhatsApp, Google, and Microsoft connections through hosted Cloud infrastructure.",
  },
  {
    icon: Bot,
    label: "Cloud agents",
    description:
      "Keep agents online when this Mac is asleep and switch between hosted agents from every device.",
  },
  {
    icon: KeyRound,
    label: "API keys and app publishing",
    description:
      "Create Cloud API keys, register apps, and connect external products to your agents.",
  },
  {
    icon: CreditCard,
    label: "Credits and billing",
    description:
      "Use shared Cloud inference, track spend, and configure top-ups from one account.",
  },
  {
    icon: Store,
    label: "Marketplace and monetization",
    description:
      "Publish apps, sell capabilities, and unlock creator revenue surfaces as they roll out.",
  },
] as const;

export function CloudOverviewSection() {
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
    id: "cloud-connect",
    role: "button",
    label: elizaCloudConnected ? "Open Eliza Cloud" : "Connect Eliza Cloud",
    group: "cloud",
    status: elizaCloudConnected ? "connected" : "available",
    onActivate: elizaCloudLoginBusy ? undefined : handleConnect,
  });

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.cloudOverview.title", {
          defaultValue: "Eliza Cloud",
        })}
        description={t("settings.cloudOverview.description", {
          defaultValue:
            "Keep Eliza local-first, then add hosted services when you want always-on agents, managed connectors, publishing, and account-backed inference.",
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
              ? t("settings.cloudOverview.connecting", {
                  defaultValue: "Connecting...",
                })
              : elizaCloudConnected
                ? t("settings.cloudOverview.connectedCta", {
                    defaultValue: "Cloud connected",
                  })
                : t("settings.cloudOverview.connectCta", {
                    defaultValue: "Connect Cloud",
                  })}
          </Button>
        }
      >
        <SettingsRow
          icon={Rocket}
          label={t("settings.cloudOverview.localModeLabel", {
            defaultValue: elizaCloudConnected
              ? "Cloud is connected"
              : "Local mode is active",
          })}
          description={t("settings.cloudOverview.localModeDescription", {
            defaultValue: elizaCloudConnected
              ? "Eliza can use Cloud account features while keeping this local runtime available."
              : "This build keeps agent runtime and local connectors on your machine unless you choose to connect Cloud.",
          })}
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.cloudOverview.unlockTitle", {
          defaultValue: "Unlock with Cloud",
        })}
      >
        {CLOUD_FEATURES.map((feature) => (
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
