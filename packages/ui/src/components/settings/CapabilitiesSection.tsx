import { AlertTriangle, Cloud, Loader2, PlugZap } from "lucide-react";
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
  mode?:
    | "endpoint"
    | "cloud"
    | "e2b"
    | "home-machine"
    | "mobile-companion"
    | "desktop-companion";
  provider?: "e2b" | "home-machine" | "mobile-companion" | "desktop-companion";
  agentId?: string;
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
  const [capabilityConnectMode, setCapabilityConnectMode] = useState<
    "endpoint" | "cloud"
  >("endpoint");
  const [capabilityEndpointProvider, setCapabilityEndpointProvider] = useState<
    "direct" | "e2b" | "home-machine" | "mobile-companion" | "desktop-companion"
  >("direct");
  const [capabilityEndpointUrl, setCapabilityEndpointUrl] = useState("");
  const [capabilityEndpointId, setCapabilityEndpointId] = useState("");
  const [capabilityEndpointToken, setCapabilityEndpointToken] = useState("");
  const [capabilityCloudApiBase, setCapabilityCloudApiBase] = useState("");
  const [capabilityCloudAuthToken, setCapabilityCloudAuthToken] = useState("");
  const [capabilityCloudName, setCapabilityCloudName] = useState("");
  const [capabilityCloudBio, setCapabilityCloudBio] = useState("");
  const [capabilityAllowedModules, setCapabilityAllowedModules] = useState("");
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
      const cloudApiBase = capabilityCloudApiBase.trim();
      const cloudAuthToken = capabilityCloudAuthToken.trim();
      const cloudName = capabilityCloudName.trim();
      if (capabilityConnectMode === "endpoint" && !baseUrl) {
        setCapabilityConnectError(
          t("capabilities.error.endpointRequired", {
            defaultValue: "Endpoint URL is required.",
          }),
        );
        setCapabilityConnectResult(null);
        return;
      }
      if (capabilityConnectMode === "cloud" && !cloudApiBase) {
        setCapabilityConnectError(
          t("capabilities.error.cloudApiBaseRequired", {
            defaultValue: "Cloud API base URL is required.",
          }),
        );
        setCapabilityConnectResult(null);
        return;
      }
      if (capabilityConnectMode === "cloud" && !cloudAuthToken) {
        setCapabilityConnectError(
          t("capabilities.error.cloudAuthTokenRequired", {
            defaultValue: "Cloud auth token is required.",
          }),
        );
        setCapabilityConnectResult(null);
        return;
      }
      if (capabilityConnectMode === "cloud" && !cloudName) {
        setCapabilityConnectError(
          t("capabilities.error.cloudNameRequired", {
            defaultValue: "Cloud sandbox name is required.",
          }),
        );
        setCapabilityConnectResult(null);
        return;
      }

      setCapabilityConnectLoading(true);
      setCapabilityConnectError(null);
      setCapabilityConnectResult(null);
      const allowedModuleIds = [
        ...new Set(
          capabilityAllowedModules
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
      try {
        const response = await client.fetch<CapabilityRouterConnectResponse>(
          "/api/capability-router/connect",
          {
            method: "POST",
            body: JSON.stringify(
              capabilityConnectMode === "endpoint"
                ? {
                    ...(capabilityEndpointProvider === "direct"
                      ? {}
                      : { provider: capabilityEndpointProvider }),
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
                    ...(allowedModuleIds.length === 0
                      ? {}
                      : { allowedModuleIds }),
                  }
                : {
                    cloud: {
                      cloudApiBase,
                      authToken: cloudAuthToken,
                      name: cloudName,
                      ...(capabilityCloudBio.trim()
                        ? {
                            bio: capabilityCloudBio
                              .split("\n")
                              .map((item) => item.trim())
                              .filter(Boolean),
                          }
                        : {}),
                      ...(capabilityEndpointId.trim()
                        ? { endpointId: capabilityEndpointId.trim() }
                        : {}),
                      ...(capabilityEndpointToken.trim()
                        ? { token: capabilityEndpointToken.trim() }
                        : {}),
                      ...(allowedModuleIds.length === 0
                        ? {}
                        : { allowedModuleIds }),
                    },
                    persist: true,
                    unloadMissing: false,
                  },
            ),
          },
        );
        setCapabilityConnectResult(response);
      } catch (err) {
        setCapabilityConnectError(
          err instanceof Error
            ? err.message
            : t("capabilities.error.connectFailed", {
                defaultValue: "Failed to connect capability router endpoint.",
              }),
        );
      } finally {
        setCapabilityConnectLoading(false);
      }
    },
    [
      capabilityAllowedModules,
      capabilityCloudApiBase,
      capabilityCloudAuthToken,
      capabilityCloudBio,
      capabilityCloudName,
      capabilityConnectMode,
      capabilityEndpointId,
      capabilityEndpointProvider,
      capabilityEndpointToken,
      capabilityEndpointUrl,
      t,
    ],
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
        <fieldset
          className="inline-flex rounded-sm border border-border p-0.5"
          aria-label={t("capabilities.connectionModeAria", {
            defaultValue: "Capability router connection mode",
          })}
        >
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-2xs ${
              capabilityConnectMode === "endpoint"
                ? "bg-accent text-accent-foreground"
                : "text-muted-strong"
            }`}
            aria-pressed={capabilityConnectMode === "endpoint"}
            onClick={() => setCapabilityConnectMode("endpoint")}
          >
            <PlugZap className="h-3.5 w-3.5" aria-hidden />
            {t("capabilities.mode.endpoint", { defaultValue: "Endpoint" })}
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-2xs ${
              capabilityConnectMode === "cloud"
                ? "bg-accent text-accent-foreground"
                : "text-muted-strong"
            }`}
            aria-pressed={capabilityConnectMode === "cloud"}
            onClick={() => setCapabilityConnectMode("cloud")}
          >
            <Cloud className="h-3.5 w-3.5" aria-hidden />
            {t("capabilities.mode.cloud", { defaultValue: "Cloud" })}
          </button>
        </fieldset>
        {capabilityConnectMode === "cloud" ? (
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Input
              value={capabilityCloudApiBase}
              onChange={(event) =>
                setCapabilityCloudApiBase(event.target.value)
              }
              placeholder="https://api.elizacloud.ai"
              aria-label={t("capabilities.cloud.apiBaseAria", {
                defaultValue: "Capability cloud API base URL",
              })}
              autoComplete="url"
              inputMode="url"
            />
            <Input
              value={capabilityCloudAuthToken}
              onChange={(event) =>
                setCapabilityCloudAuthToken(event.target.value)
              }
              placeholder={t("capabilities.cloud.tokenPlaceholder", {
                defaultValue: "Cloud API token",
              })}
              aria-label={t("capabilities.cloud.authTokenAria", {
                defaultValue: "Capability cloud auth token",
              })}
              type="password"
              autoComplete="off"
            />
            <Input
              value={capabilityCloudName}
              onChange={(event) => setCapabilityCloudName(event.target.value)}
              placeholder={t("capabilities.cloud.namePlaceholder", {
                defaultValue: "Remote Tools Sandbox",
              })}
              aria-label={t("capabilities.cloud.nameAria", {
                defaultValue: "Capability cloud sandbox name",
              })}
              autoComplete="off"
            />
            <Input
              value={capabilityCloudBio}
              onChange={(event) => setCapabilityCloudBio(event.target.value)}
              placeholder={t("capabilities.cloud.bioPlaceholder", {
                defaultValue: "Sandbox bio",
              })}
              aria-label={t("capabilities.cloud.bioAria", {
                defaultValue: "Capability cloud sandbox bio",
              })}
              autoComplete="off"
            />
          </div>
        ) : null}
        {capabilityConnectMode === "endpoint" ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-2xs text-muted">
              {t("capabilities.endpoint.providerLabel", {
                defaultValue: "Capability endpoint provider",
              })}
            </span>
            <select
              value={capabilityEndpointProvider}
              onChange={(event) =>
                setCapabilityEndpointProvider(
                  event.target.value as typeof capabilityEndpointProvider,
                )
              }
              aria-label={t("capabilities.endpoint.providerLabel", {
                defaultValue: "Capability endpoint provider",
              })}
              className="h-9 w-full rounded-sm border border-input bg-background px-3 py-1 text-sm outline-none ring-offset-background transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="direct">
                {t("capabilities.provider.direct", {
                  defaultValue: "Direct endpoint",
                })}
              </option>
              <option value="e2b">
                {t("capabilities.provider.e2b", {
                  defaultValue: "E2B sandbox",
                })}
              </option>
              <option value="home-machine">
                {t("capabilities.provider.homeMachine", {
                  defaultValue: "Home machine",
                })}
              </option>
              <option value="mobile-companion">
                {t("capabilities.provider.mobileCompanion", {
                  defaultValue: "Mobile companion",
                })}
              </option>
              <option value="desktop-companion">
                {t("capabilities.provider.desktopCompanion", {
                  defaultValue: "Desktop companion",
                })}
              </option>
            </select>
          </label>
        ) : null}
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem]">
          <Input
            value={capabilityEndpointUrl}
            onChange={(event) => setCapabilityEndpointUrl(event.target.value)}
            placeholder="https://capability.example"
            aria-label={t("capabilities.endpoint.urlAria", {
              defaultValue: "Capability router endpoint URL",
            })}
            autoComplete="url"
            inputMode="url"
            disabled={capabilityConnectMode === "cloud"}
          />
          <Input
            value={capabilityEndpointId}
            onChange={(event) => setCapabilityEndpointId(event.target.value)}
            placeholder="device"
            aria-label={t("capabilities.endpoint.idAria", {
              defaultValue: "Capability router endpoint ID",
            })}
            autoComplete="off"
          />
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Input
            value={capabilityEndpointToken}
            onChange={(event) => setCapabilityEndpointToken(event.target.value)}
            placeholder={t("capabilities.endpoint.tokenPlaceholder", {
              defaultValue: "Bearer token",
            })}
            aria-label={t("capabilities.endpoint.tokenAria", {
              defaultValue: "Capability router endpoint token",
            })}
            type="password"
            autoComplete="off"
          />
          <Input
            value={capabilityAllowedModules}
            onChange={(event) =>
              setCapabilityAllowedModules(event.target.value)
            }
            placeholder="module-id, other-module"
            aria-label={t("capabilities.endpoint.modulesAria", {
              defaultValue: "Allowed remote module IDs",
            })}
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
  const { t } = useApp();
  if (status === "loading") {
    const loadingLabel = t("capabilities.status.loading", {
      defaultValue: "Loading",
    });
    return (
      <span
        className="inline-flex text-muted"
        title={loadingLabel}
        role="status"
        aria-label={loadingLabel}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      </span>
    );
  }

  if (status === "unavailable") {
    const unavailableLabel = t("capabilities.status.unavailable", {
      defaultValue: "Unavailable",
    });
    return (
      <span
        className="inline-flex text-warn"
        title={unavailableLabel}
        role="img"
        aria-label={unavailableLabel}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }

  return null;
}
