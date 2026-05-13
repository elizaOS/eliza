import { AlertTriangle, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { client } from "../../api/client";
import { useApp } from "../../state";
import { Switch } from "../ui/switch";

interface AutoTrainingConfig {
  autoTrain: boolean;
  triggerThreshold: number;
  triggerCooldownHours: number;
  backends: string[];
}

interface AutoTrainingConfigResponse {
  config: AutoTrainingConfig;
}

interface AutoTrainingStatusResponse {
  serviceRegistered?: boolean;
}

export function CapabilitiesSection() {
  const { walletEnabled, browserEnabled, computerUseEnabled, setState, t } =
    useApp();
  const [autoTrainingConfig, setAutoTrainingConfig] =
    useState<AutoTrainingConfig | null>(null);
  const [autoTrainingAvailable, setAutoTrainingAvailable] = useState<
    boolean | null
  >(null);
  const [autoTrainingLoading, setAutoTrainingLoading] = useState(true);
  const [autoTrainingSaving, setAutoTrainingSaving] = useState(false);

  const refreshAutoTraining = useCallback(async () => {
    setAutoTrainingLoading(true);
    try {
      const [configResponse, statusResponse] = await Promise.all([
        client.fetch<AutoTrainingConfigResponse>("/api/training/auto/config"),
        client.fetch<AutoTrainingStatusResponse>("/api/training/auto/status"),
      ]);
      setAutoTrainingConfig(configResponse.config);
      setAutoTrainingAvailable(statusResponse.serviceRegistered !== false);
    } catch {
      setAutoTrainingConfig(null);
      setAutoTrainingAvailable(false);
    } finally {
      setAutoTrainingLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAutoTraining();
  }, [refreshAutoTraining]);

  const handleAutoTrainingChange = useCallback(
    async (checked: boolean | "indeterminate") => {
      if (!autoTrainingConfig || autoTrainingAvailable === false) return;
      const nextConfig = { ...autoTrainingConfig, autoTrain: !!checked };
      setAutoTrainingConfig(nextConfig);
      setAutoTrainingSaving(true);
      try {
        const response = await client.fetch<AutoTrainingConfigResponse>(
          "/api/training/auto/config",
          {
            method: "POST",
            body: JSON.stringify(nextConfig),
          },
        );
        setAutoTrainingConfig(response.config);
        setAutoTrainingAvailable(true);
      } catch {
        setAutoTrainingConfig(autoTrainingConfig);
      } finally {
        setAutoTrainingSaving(false);
      }
    },
    [autoTrainingAvailable, autoTrainingConfig],
  );

  const autoTrainingDisabled =
    autoTrainingLoading ||
    autoTrainingSaving ||
    !autoTrainingConfig ||
    autoTrainingAvailable === false;
  const autoTrainingStatus =
    autoTrainingLoading || autoTrainingSaving
      ? "loading"
      : autoTrainingAvailable === false
        ? "unavailable"
        : null;

  return (
    <div className="space-y-4">
      <CapabilityRow
        label={t("nav.wallet", {
          defaultValue: "Wallet",
        })}
      >
        <Switch
          checked={walletEnabled}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            setState("walletEnabled", !!checked)
          }
          aria-label={t("settings.sections.wallet.enableLabel", {
            defaultValue: "Enable Wallet",
          })}
        />
      </CapabilityRow>
      <CapabilityRow
        label={t("nav.browser", {
          defaultValue: "Browser",
        })}
      >
        <Switch
          checked={browserEnabled}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            setState("browserEnabled", !!checked)
          }
          aria-label={t("settings.sections.capabilities.browserLabel", {
            defaultValue: "Enable Browser",
          })}
        />
      </CapabilityRow>
      <CapabilityRow
        label={t("settings.sections.capabilities.computerUseName", {
          defaultValue: "Computer Use",
        })}
        hint={
          computerUseEnabled
            ? t("settings.sections.capabilities.computerUseHint", {
                defaultValue:
                  "Accessibility and Screen Recording permissions are required for computer use.",
              })
            : null
        }
      >
        <Switch
          checked={computerUseEnabled}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            setState("computerUseEnabled", !!checked)
          }
          aria-label={t("settings.sections.capabilities.computerUseLabel", {
            defaultValue: "Enable Computer Use",
          })}
        />
      </CapabilityRow>
      <CapabilityRow
        label={t("settings.sections.capabilities.autoTrainingName", {
          defaultValue: "Auto-training",
        })}
        status={autoTrainingStatus}
      >
        <Switch
          checked={autoTrainingConfig?.autoTrain ?? false}
          disabled={autoTrainingDisabled}
          onCheckedChange={handleAutoTrainingChange}
          aria-label={t("settings.sections.capabilities.autoTrainingLabel", {
            defaultValue: "Enable Auto-training",
          })}
        />
      </CapabilityRow>
    </div>
  );
}

function CapabilityRow({
  children,
  hint,
  label,
  status,
}: {
  children: ReactNode;
  hint?: string | null;
  label: string;
  status?: "loading" | "unavailable" | null;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate font-medium text-sm">{label}</div>
          <CapabilityStatusIcon status={status} />
        </div>
        {hint ? <div className="mt-1 text-2xs text-muted">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function CapabilityStatusIcon({
  status,
}: {
  status?: "loading" | "unavailable" | null;
}) {
  if (status === "loading") {
    return (
      <span
        className="inline-flex text-muted"
        title="Loading"
        role="status"
        aria-label="Loading"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      </span>
    );
  }

  if (status === "unavailable") {
    return (
      <span
        className="inline-flex text-warn"
        title="Unavailable"
        role="img"
        aria-label="Unavailable"
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }

  return null;
}
