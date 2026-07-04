/**
 * Settings → Capabilities section (the `capabilities` section id). Toggles the
 * wallet / browser / computer-use capabilities on the App state, sets the
 * proactive-interaction chattiness (persisted to `config.env` under
 * ELIZA_PROACTIVE_INTERACTIONS), manages auto-training config, and hosts the
 * Capability Router connect form for endpoint- or cloud-hosted capability
 * providers.
 */

import {
  AlertTriangle,
  Cloud,
  Globe,
  GraduationCap,
  Loader2,
  MessageCircle,
  MonitorCog,
  PlugZap,
  Wallet,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { client } from "../../api/client";
import { isApiError } from "../../api/client-types-core";
import { useAppSelector, useAppSelectorShallow } from "../../state";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import {
  SettingsActionButton,
  SettingsInputRow,
  SettingsSegmentedRow,
  SettingsSelectRow,
  SettingsSwitchRow,
} from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

/**
 * Env key the proactive-interaction decider reads (`#8792`). Persisted into
 * `config.env` (propagated to `process.env` at boot) and resolved at decider
 * registration via `runtime.getSetting(ELIZA_PROACTIVE_INTERACTIONS)`.
 */
const PROACTIVE_INTERACTIONS_ENV_KEY = "ELIZA_PROACTIVE_INTERACTIONS";

/** Matches `ProactiveChattiness` in the agent's proactive-interaction gate. */
type ProactiveChattiness = "off" | "subtle" | "chatty";

const PROACTIVE_CHATTINESS_VALUES: readonly ProactiveChattiness[] = [
  "off",
  "subtle",
  "chatty",
];

type CapabilityConnectMode = "endpoint" | "cloud";

/** Default when no value is persisted (mirrors the gate's `subtle` default). */
const DEFAULT_PROACTIVE_CHATTINESS: ProactiveChattiness = "subtle";

function readProactiveChattinessFromEnv(
  env: unknown,
): ProactiveChattiness | null {
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const record = env as Record<string, unknown>;
  const vars =
    record.vars &&
    typeof record.vars === "object" &&
    !Array.isArray(record.vars)
      ? (record.vars as Record<string, unknown>)
      : undefined;
  const raw =
    record[PROACTIVE_INTERACTIONS_ENV_KEY] ??
    vars?.[PROACTIVE_INTERACTIONS_ENV_KEY];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (PROACTIVE_CHATTINESS_VALUES as readonly string[]).includes(value)
    ? (value as ProactiveChattiness)
    : null;
}

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
    useAppSelectorShallow((s) => ({
      walletEnabled: s.walletEnabled,
      browserEnabled: s.browserEnabled,
      computerUseEnabled: s.computerUseEnabled,
      setState: s.setState,
      t: s.t,
    }));
  const advancedEnabled = useAdvancedSettingsEnabled();
  const [proactiveChattiness, setProactiveChattiness] =
    useState<ProactiveChattiness>(DEFAULT_PROACTIVE_CHATTINESS);
  const [proactiveSaving, setProactiveSaving] = useState(false);
  const [autoTrainingConfig, setAutoTrainingConfig] =
    useState<AutoTrainingConfig | null>(null);
  const [autoTrainingAvailable, setAutoTrainingAvailable] = useState<
    boolean | null
  >(null);
  const [autoTrainingLoading, setAutoTrainingLoading] = useState(true);
  const [autoTrainingSaving, setAutoTrainingSaving] = useState(false);
  // Distinguishes a broken auto-training endpoint (5xx/transport/parse →
  // error icon) from the designed "service not hosted here" degrade
  // (404/service-unregistered → unavailable icon). Three-state rule: a broken
  // endpoint must not masquerade as the designed unavailable state.
  const [autoTrainingError, setAutoTrainingError] = useState(false);
  const [capabilityConnectMode, setCapabilityConnectMode] =
    useState<CapabilityConnectMode>("endpoint");
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
      setAutoTrainingError(false);
    } catch (err) {
      // error-policy:J4 404 = training plugin not hosted on this runtime — the
      // designed "unavailable" degrade. Any other failure (5xx, transport,
      // parse) renders the explicit error icon instead of silently disabling
      // the control as if unavailability were by design.
      setAutoTrainingConfig(null);
      setAutoTrainingAvailable(false);
      setAutoTrainingError(!(isApiError(err) && err.status === 404));
    } finally {
      setAutoTrainingLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAutoTraining();
  }, [refreshAutoTraining]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await client.getConfig();
        const resolved = readProactiveChattinessFromEnv(config.env);
        if (!cancelled && resolved) setProactiveChattiness(resolved);
      } catch {
        // Leave the default when config is unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProactiveChattinessChange = useCallback(
    async (next: string) => {
      if (!(PROACTIVE_CHATTINESS_VALUES as readonly string[]).includes(next)) {
        return;
      }
      const value = next as ProactiveChattiness;
      const previous = proactiveChattiness;
      if (value === previous) return;
      setProactiveChattiness(value);
      setProactiveSaving(true);
      try {
        await client.updateConfig({
          env: { [PROACTIVE_INTERACTIONS_ENV_KEY]: value },
        });
      } catch {
        setProactiveChattiness(previous);
      } finally {
        setProactiveSaving(false);
      }
    },
    [proactiveChattiness],
  );

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
        setAutoTrainingError(false);
      } catch {
        // error-policy:J4 revert the optimistic toggle AND flag the failed
        // save — a silent revert previously made the click look like it never
        // happened, hiding a broken save endpoint behind healthy UI.
        setAutoTrainingConfig(autoTrainingConfig);
        setAutoTrainingError(true);
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
      : autoTrainingError
        ? "error"
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
        action={<AdvancedToggle label="Advanced" />}
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
        <SettingsSegmentedRow
          agentId="capability-proactive-suggestions"
          icon={MessageCircle}
          label={t("settings.sections.capabilities.proactiveName", {
            defaultValue: "Proactive suggestions",
          })}
          agentLabel={t("settings.sections.capabilities.proactiveLabel", {
            defaultValue: "Proactive suggestions",
          })}
          description={t("settings.sections.capabilities.proactiveHint", {
            defaultValue:
              "How often the agent offers a helpful suggestion when you switch views or run a shortcut.",
          })}
          group="capabilities"
          testId="capability-proactive-suggestions"
          value={proactiveChattiness}
          onValueChange={(value) => void handleProactiveChattinessChange(value)}
          disabled={proactiveSaving}
          options={[
            {
              value: "off",
              label: t("settings.sections.capabilities.proactiveOff", {
                defaultValue: "Off",
              }),
            },
            {
              value: "subtle",
              label: t("settings.sections.capabilities.proactiveSubtle", {
                defaultValue: "Subtle",
              }),
            },
            {
              value: "chatty",
              label: t("settings.sections.capabilities.proactiveChatty", {
                defaultValue: "Chatty",
              }),
            },
          ]}
        />
      </SettingsGroup>

      {advancedEnabled ? (
        <form onSubmit={handleCapabilityConnect}>
          <SettingsGroup
            title={t("settings.sections.capabilities.capabilityRouterName", {
              defaultValue: "Capability Router",
            })}
            footer={
              capabilityConnectError ? (
                <span className="text-warn" role="alert">
                  {capabilityConnectError}
                </span>
              ) : capabilityConnectResult?.success ? (
                <span className="text-ok" role="status">
                  {t(
                    "settings.sections.capabilities.capabilityRouterConnected",
                    {
                      defaultValue: "Connected remote capability endpoint.",
                    },
                  )}{" "}
                  {capabilityConnectResult.sync?.registered?.length
                    ? capabilityConnectResult.sync.registered.join(", ")
                    : capabilityConnectResult.endpoint?.baseUrl}
                </span>
              ) : undefined
            }
          >
            <SettingsSegmentedRow
              agentId="cap-mode"
              group="capability-router"
              label={t("capabilities.connectionModeLabel", {
                defaultValue: "Connection",
              })}
              agentLabel={t("capabilities.connectionModeAria", {
                defaultValue: "Capability router connection mode",
              })}
              value={capabilityConnectMode}
              onValueChange={(value) =>
                setCapabilityConnectMode(value as CapabilityConnectMode)
              }
              options={[
                {
                  value: "endpoint",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <PlugZap className="h-4 w-4" aria-hidden />
                      {t("capabilities.mode.endpoint", {
                        defaultValue: "Endpoint",
                      })}
                    </span>
                  ),
                },
                {
                  value: "cloud",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Cloud className="h-4 w-4" aria-hidden />
                      {t("capabilities.mode.cloud", {
                        defaultValue: "Cloud",
                      })}
                    </span>
                  ),
                },
              ]}
            />

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
              label={t(
                "settings.sections.capabilities.capabilityRouterConnect",
                {
                  defaultValue: "Connect",
                },
              )}
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
      ) : null}
    </SettingsStack>
  );
}

function CapabilityStatusIcon({
  status,
}: {
  status?: "loading" | "unavailable" | "error" | null;
}) {
  const t = useAppSelector((s) => s.t);
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

  if (status === "error") {
    const errorLabel = t("capabilities.status.error", {
      defaultValue: "Error",
    });
    return (
      <span
        className="inline-flex text-danger"
        title={errorLabel}
        role="img"
        aria-label={errorLabel}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }

  return null;
}
