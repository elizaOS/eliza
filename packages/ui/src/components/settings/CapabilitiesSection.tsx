import {
  AlertTriangle,
  Cloud,
  Globe,
  GraduationCap,
  Loader2,
  MonitorCog,
  PlugZap,
  Wallet,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import { useApp } from "../../state";
import { Button } from "../ui/button";
import {
  SettingsActionButton,
  SettingsInputRow,
  SettingsSelectRow,
  SettingsSwitchRow,
} from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

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
    <SettingsStack>
      <SettingsGroup
        title={t("settings.sections.capabilities.groupTitle", {
          defaultValue: "Capabilities",
        })}
      >
        <SettingsSwitchRow
          agentId="capability-wallet"
          icon={Wallet}
          label={t("nav.wallet", { defaultValue: "Wallet" })}
          agentLabel={t("settings.sections.wallet.enableLabel", {
            defaultValue: "Enable Wallet",
          })}
          group="capabilities"
          checked={walletEnabled}
          onCheckedChange={(checked) => setState("walletEnabled", checked)}
        />
        <SettingsSwitchRow
          agentId="capability-browser"
          icon={Globe}
          label={t("nav.browser", { defaultValue: "Browser" })}
          agentLabel={t("settings.sections.capabilities.browserLabel", {
            defaultValue: "Enable Browser",
          })}
          group="capabilities"
          checked={browserEnabled}
          onCheckedChange={(checked) => setState("browserEnabled", checked)}
        />
        <SettingsSwitchRow
          agentId="capability-computer-use"
          icon={MonitorCog}
          label={t("settings.sections.capabilities.computerUseName", {
            defaultValue: "Computer Use",
          })}
          agentLabel={t("settings.sections.capabilities.computerUseLabel", {
            defaultValue: "Enable Computer Use",
          })}
          group="capabilities"
          description={
            computerUseEnabled
              ? t("settings.sections.capabilities.computerUseHint", {
                  defaultValue:
                    "Accessibility and Screen Recording permissions are required for computer use.",
                })
              : undefined
          }
          checked={computerUseEnabled}
          onCheckedChange={(checked) => setState("computerUseEnabled", checked)}
        />
        <SettingsSwitchRow
          agentId="capability-auto-training"
          icon={GraduationCap}
          label={
            <span className="inline-flex items-center gap-2">
              {t("settings.sections.capabilities.autoTrainingName", {
                defaultValue: "Auto-training",
              })}
              <CapabilityStatusIcon status={autoTrainingStatus} />
            </span>
          }
          agentLabel={t("settings.sections.capabilities.autoTrainingLabel", {
            defaultValue: "Enable Auto-training",
          })}
          group="capabilities"
          disabled={autoTrainingDisabled}
          checked={autoTrainingConfig?.autoTrain ?? false}
          onCheckedChange={(checked) => handleAutoTrainingChange(checked)}
        />
      </SettingsGroup>

      <form onSubmit={handleCapabilityConnect}>
        <SettingsGroup
          title={t("settings.sections.capabilities.capabilityRouterName", {
            defaultValue: "Capability Router",
          })}
          description={t(
            "settings.sections.capabilities.capabilityRouterHint",
            {
              defaultValue:
                "Connect a remote endpoint that adds plugins, routes, apps, and views.",
            },
          )}
          footer={
            capabilityConnectError ? (
              <span className="text-warn" role="alert">
                {capabilityConnectError}
              </span>
            ) : capabilityConnectResult?.success ? (
              <span className="text-ok" role="status">
                {t("settings.sections.capabilities.capabilityRouterConnected", {
                  defaultValue: "Connected remote capability endpoint.",
                })}{" "}
                {capabilityConnectResult.sync?.registered?.length
                  ? capabilityConnectResult.sync.registered.join(", ")
                  : capabilityConnectResult.endpoint?.baseUrl}
              </span>
            ) : undefined
          }
        >
          <SettingsRow
            label={t("capabilities.connectionModeLabel", {
              defaultValue: "Connection",
            })}
            description={t("capabilities.connectionModeAria", {
              defaultValue: "Capability router connection mode",
            })}
            stacked
          >
            <div
              className="flex gap-2"
              role="tablist"
              aria-label={t("capabilities.connectionModeAria", {
                defaultValue: "Capability router connection mode",
              })}
            >
              <CapabilityModeButton
                agentId="cap-mode-endpoint"
                icon={PlugZap}
                label={t("capabilities.mode.endpoint", {
                  defaultValue: "Endpoint",
                })}
                selected={capabilityConnectMode === "endpoint"}
                onSelect={() => setCapabilityConnectMode("endpoint")}
              />
              <CapabilityModeButton
                agentId="cap-mode-cloud"
                icon={Cloud}
                label={t("capabilities.mode.cloud", { defaultValue: "Cloud" })}
                selected={capabilityConnectMode === "cloud"}
                onSelect={() => setCapabilityConnectMode("cloud")}
              />
            </div>
          </SettingsRow>

          {capabilityConnectMode === "cloud" ? (
            <>
              <SettingsInputRow
                agentId="cap-cloud-api-base"
                group="capability-router"
                label={t("capabilities.cloud.apiBaseLabel", {
                  defaultValue: "Cloud API base URL",
                })}
                agentLabel={t("capabilities.cloud.apiBaseAria", {
                  defaultValue: "Capability cloud API base URL",
                })}
                value={capabilityCloudApiBase}
                onValueChange={setCapabilityCloudApiBase}
                placeholder="https://api.elizacloud.ai"
                autoComplete="url"
                inputMode="url"
              />
              <SettingsInputRow
                agentId="cap-cloud-token"
                group="capability-router"
                label={t("capabilities.cloud.tokenLabel", {
                  defaultValue: "Cloud auth token",
                })}
                agentLabel={t("capabilities.cloud.authTokenAria", {
                  defaultValue: "Capability cloud auth token",
                })}
                value={capabilityCloudAuthToken}
                onValueChange={setCapabilityCloudAuthToken}
                placeholder={t("capabilities.cloud.tokenPlaceholder", {
                  defaultValue: "Cloud API token",
                })}
                type="password"
                autoComplete="off"
              />
              <SettingsInputRow
                agentId="cap-cloud-name"
                group="capability-router"
                label={t("capabilities.cloud.nameLabel", {
                  defaultValue: "Sandbox name",
                })}
                agentLabel={t("capabilities.cloud.nameAria", {
                  defaultValue: "Capability cloud sandbox name",
                })}
                value={capabilityCloudName}
                onValueChange={setCapabilityCloudName}
                placeholder={t("capabilities.cloud.namePlaceholder", {
                  defaultValue: "Remote Tools Sandbox",
                })}
                autoComplete="off"
              />
              <SettingsInputRow
                agentId="cap-cloud-bio"
                group="capability-router"
                label={t("capabilities.cloud.bioLabel", {
                  defaultValue: "Sandbox bio",
                })}
                agentLabel={t("capabilities.cloud.bioAria", {
                  defaultValue: "Capability cloud sandbox bio",
                })}
                value={capabilityCloudBio}
                onValueChange={setCapabilityCloudBio}
                placeholder={t("capabilities.cloud.bioPlaceholder", {
                  defaultValue: "Sandbox bio",
                })}
                autoComplete="off"
              />
            </>
          ) : null}

          {capabilityConnectMode === "endpoint" ? (
            <SettingsSelectRow
              agentId="cap-endpoint-provider"
              group="capability-router"
              label={t("capabilities.endpoint.providerLabel", {
                defaultValue: "Capability endpoint provider",
              })}
              value={capabilityEndpointProvider}
              onValueChange={(value) =>
                setCapabilityEndpointProvider(
                  value as typeof capabilityEndpointProvider,
                )
              }
              options={[
                {
                  value: "direct",
                  label: t("capabilities.provider.direct", {
                    defaultValue: "Direct endpoint",
                  }),
                },
                {
                  value: "e2b",
                  label: t("capabilities.provider.e2b", {
                    defaultValue: "E2B sandbox",
                  }),
                },
                {
                  value: "home-machine",
                  label: t("capabilities.provider.homeMachine", {
                    defaultValue: "Home machine",
                  }),
                },
                {
                  value: "mobile-companion",
                  label: t("capabilities.provider.mobileCompanion", {
                    defaultValue: "Mobile companion",
                  }),
                },
                {
                  value: "desktop-companion",
                  label: t("capabilities.provider.desktopCompanion", {
                    defaultValue: "Desktop companion",
                  }),
                },
              ]}
            />
          ) : null}

          <SettingsInputRow
            agentId="cap-endpoint-url"
            group="capability-router"
            label={t("capabilities.endpoint.urlLabel", {
              defaultValue: "Endpoint URL",
            })}
            agentLabel={t("capabilities.endpoint.urlAria", {
              defaultValue: "Capability router endpoint URL",
            })}
            value={capabilityEndpointUrl}
            onValueChange={setCapabilityEndpointUrl}
            placeholder="https://capability.example"
            autoComplete="url"
            inputMode="url"
            disabled={capabilityConnectMode === "cloud"}
          />
          <SettingsInputRow
            agentId="cap-endpoint-id"
            group="capability-router"
            label={t("capabilities.endpoint.idLabel", {
              defaultValue: "Endpoint ID",
            })}
            agentLabel={t("capabilities.endpoint.idAria", {
              defaultValue: "Capability router endpoint ID",
            })}
            value={capabilityEndpointId}
            onValueChange={setCapabilityEndpointId}
            placeholder="device"
            autoComplete="off"
          />
          <SettingsInputRow
            agentId="cap-endpoint-token"
            group="capability-router"
            label={t("capabilities.endpoint.tokenLabel", {
              defaultValue: "Bearer token",
            })}
            agentLabel={t("capabilities.endpoint.tokenAria", {
              defaultValue: "Capability router endpoint token",
            })}
            value={capabilityEndpointToken}
            onValueChange={setCapabilityEndpointToken}
            placeholder={t("capabilities.endpoint.tokenPlaceholder", {
              defaultValue: "Bearer token",
            })}
            type="password"
            autoComplete="off"
          />
          <SettingsInputRow
            agentId="cap-endpoint-modules"
            group="capability-router"
            label={t("capabilities.endpoint.modulesLabel", {
              defaultValue: "Allowed module IDs",
            })}
            agentLabel={t("capabilities.endpoint.modulesAria", {
              defaultValue: "Allowed remote module IDs",
            })}
            value={capabilityAllowedModules}
            onValueChange={setCapabilityAllowedModules}
            placeholder="module-id, other-module"
            autoComplete="off"
          />
          <SettingsRow
            label={t("settings.sections.capabilities.capabilityRouterConnect", {
              defaultValue: "Connect",
            })}
            stacked
          >
            <SettingsActionButton
              agentId="cap-connect-submit"
              agentGroup="capability-router"
              agentLabel={t(
                "settings.sections.capabilities.capabilityRouterConnect",
                { defaultValue: "Connect" },
              )}
              agentStatus={capabilityConnectLoading ? "loading" : undefined}
              type="submit"
              disabled={capabilityConnectLoading}
              className="h-11 w-full gap-2 rounded-md text-sm"
            >
              {capabilityConnectLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <PlugZap className="h-4 w-4" aria-hidden />
              )}
              {t("settings.sections.capabilities.capabilityRouterConnect", {
                defaultValue: "Connect",
              })}
            </SettingsActionButton>
          </SettingsRow>
        </SettingsGroup>
      </form>
    </SettingsStack>
  );
}

function CapabilityModeButton({
  agentId,
  icon: Icon,
  label,
  selected,
  onSelect,
}: {
  agentId: string;
  icon: typeof PlugZap;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "tab",
    label,
    group: "capability-router",
    status: selected ? "active" : "inactive",
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      type="button"
      variant={selected ? "default" : "outline"}
      className="h-11 flex-1 gap-1.5 rounded-md px-3 text-sm"
      aria-pressed={selected}
      onClick={onSelect}
      {...agentProps}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </Button>
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
