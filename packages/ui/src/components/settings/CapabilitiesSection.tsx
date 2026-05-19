import { AlertTriangle, Loader2, PlugZap } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { client } from "../../api/client";
import { useApp } from "../../state";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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

type CapabilityRouterConnectResponse = {
  success?: boolean;
  endpoint?: {
    id?: string;
    baseUrl?: string;
    hasToken?: boolean;
  };
  sync?: {
    registered?: string[];
    unloaded?: string[];
    skipped?: string[];
  };
};

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
  const [capabilityEndpointUrl, setCapabilityEndpointUrl] = useState("");
  const [capabilityEndpointId, setCapabilityEndpointId] = useState("");
  const [capabilityEndpointToken, setCapabilityEndpointToken] = useState("");
  const [capabilityConnectLoading, setCapabilityConnectLoading] =
    useState(false);
  const [capabilityConnectError, setCapabilityConnectError] = useState<
    string | null
  >(null);
  const [capabilityConnectResult, setCapabilityConnectResult] =
    useState<CapabilityRouterConnectResponse | null>(null);

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

  const handleCapabilityConnect = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const baseUrl = capabilityEndpointUrl.trim();
      if (!baseUrl) {
        setCapabilityConnectError("Endpoint URL is required.");
        setCapabilityConnectResult(null);
        return;
      }

      setCapabilityConnectLoading(true);
      setCapabilityConnectError(null);
      setCapabilityConnectResult(null);
      try {
        const response = await client.fetch<CapabilityRouterConnectResponse>(
          "/api/capability-router/connect",
          {
            method: "POST",
            body: JSON.stringify({
              endpoint: {
                baseUrl,
                ...(capabilityEndpointId.trim()
                  ? { id: capabilityEndpointId.trim() }
                  : {}),
                ...(capabilityEndpointToken.trim()
                  ? { token: capabilityEndpointToken.trim() }
                  : {}),
              },
              persist: true,
              unloadMissing: false,
            }),
          },
        );
        setCapabilityConnectResult(response);
      } catch (err) {
        setCapabilityConnectError(
          err instanceof Error
            ? err.message
            : "Failed to connect capability router endpoint.",
        );
      } finally {
        setCapabilityConnectLoading(false);
      }
    },
    [capabilityEndpointId, capabilityEndpointToken, capabilityEndpointUrl],
  );

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
      <form
        className="space-y-3 border-border border-t pt-4"
        onSubmit={handleCapabilityConnect}
      >
        <div className="flex items-start gap-3">
          <PlugZap className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm">
              {t("settings.sections.capabilities.capabilityRouterName", {
                defaultValue: "Capability Router",
              })}
            </div>
            <div className="mt-1 text-2xs text-muted">
              {t("settings.sections.capabilities.capabilityRouterHint", {
                defaultValue:
                  "Connect a remote endpoint that contributes plugin actions, providers, routes, apps, and views.",
              })}
            </div>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem]">
          <Input
            value={capabilityEndpointUrl}
            onChange={(event) => setCapabilityEndpointUrl(event.target.value)}
            placeholder="https://capability.example"
            aria-label="Capability router endpoint URL"
            autoComplete="url"
            inputMode="url"
          />
          <Input
            value={capabilityEndpointId}
            onChange={(event) => setCapabilityEndpointId(event.target.value)}
            placeholder="device"
            aria-label="Capability router endpoint ID"
            autoComplete="off"
          />
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            value={capabilityEndpointToken}
            onChange={(event) => setCapabilityEndpointToken(event.target.value)}
            placeholder="Bearer token"
            aria-label="Capability router endpoint token"
            type="password"
            autoComplete="off"
          />
          <Button type="submit" disabled={capabilityConnectLoading}>
            {capabilityConnectLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <PlugZap className="h-4 w-4" aria-hidden />
            )}
            {t("settings.sections.capabilities.capabilityRouterConnect", {
              defaultValue: "Connect",
            })}
          </Button>
        </div>
        {capabilityConnectError ? (
          <div className="text-2xs text-danger" role="alert">
            {capabilityConnectError}
          </div>
        ) : null}
        {capabilityConnectResult?.success ? (
          <div className="text-2xs text-muted-strong" role="status">
            {t("settings.sections.capabilities.capabilityRouterConnected", {
              defaultValue: "Connected remote capability endpoint.",
            })}{" "}
            {capabilityConnectResult.sync?.registered?.length
              ? capabilityConnectResult.sync.registered.join(", ")
              : capabilityConnectResult.endpoint?.baseUrl}
          </div>
        ) : null}
      </form>
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
