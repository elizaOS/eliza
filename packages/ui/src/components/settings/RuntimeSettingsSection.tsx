/**
 * Settings → Runtime section (the `runtime` section id). Shows where the agent
 * currently runs (local / remote / cloud, from `GET /api/runtime/mode` with a
 * local heuristic fallback) and lets the user switch targets: connect to a
 * remote agent URL+token, or migrate the desktop state dir / pick a workspace
 * folder via the Electrobun bridge. The Local option is hidden on builds that
 * ship without an on-device runtime (store build, Android cloud build).
 */

import { Cloud, Laptop, type LucideIcon, RadioTower } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  inspectExistingElizaInstall,
  migrateDesktopStateDir,
  pickDesktopWorkspaceFolder,
} from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { isStoreBuild } from "../../build-variant";
import { CONNECT_EVENT, dispatchAppEvent } from "../../events";
import { normalizeRemoteAgentUrl } from "../../first-run/adopt-remote-first-run";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import {
  type FirstRunReloadTarget,
  reloadIntoFirstRunRuntime,
} from "../../first-run/reload-into-first-run-runtime";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useAppSelector } from "../../state";
import {
  type AgentRuntimeTargetKind,
  inferAgentRuntimeTarget,
} from "../../state/agent-runtime-target";
import { loadPersistedActiveServer } from "../../state/persistence";
import { Input } from "../ui/input";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

function RuntimeModeRow({
  target,
  icon,
  label,
  description,
  active,
  disabled,
  onSelect,
}: {
  target: FirstRunReloadTarget;
  icon: LucideIcon;
  label: string;
  description?: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `runtime-mode-${target}`,
    role: "card",
    label,
    description,
    group: "runtime-mode",
    status: active ? "active" : "inactive",
    onActivate: disabled ? undefined : onSelect,
  });
  return (
    <SettingsRow
      icon={icon}
      label={label}
      description={description}
      active={active}
      disabled={disabled}
      onClick={onSelect}
      buttonRef={ref}
      buttonProps={agentProps}
    />
  );
}

type RuntimeAction = {
  target: FirstRunReloadTarget;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
};

const STORE_LOCAL_DISABLED_DOCS_URL =
  "https://github.com/eliza-ai/eliza/blob/develop/docs/desktop/build-variants.md";

export function RuntimeSettingsSection() {
  const t = useAppSelector((s) => s.t);
  const { state: runtimeModeState } = useRuntimeMode();
  const advancedEnabled = useAdvancedSettingsEnabled();
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [remoteFormOpen, setRemoteFormOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);

  // Prefer the authoritative server snapshot (`GET /api/runtime/mode`); fall
  // back to the local heuristic when it is loading or unreachable.
  const currentRuntime = useMemo(() => {
    const fallback = inferAgentRuntimeTarget({
      activeServer: loadPersistedActiveServer(),
      mobileRuntimeMode: readPersistedMobileRuntimeMode(),
    });
    if (runtimeModeState.phase !== "ready") return fallback;
    const kind: AgentRuntimeTargetKind =
      runtimeModeState.snapshot.deploymentRuntime;
    return { kind, label: fallback.label };
  }, [runtimeModeState]);

  const storeBuild = isStoreBuild();
  const localDisabledReason = storeBuild
    ? t("settings.runtime.localDisabledStore", {
        defaultValue:
          "Local agent requires the direct download build. Open docs for details.",
      })
    : undefined;

  // The Play-Store Android build (`build:android:cloud`) ships without an
  // on-device agent runtime, so the Local option must be hidden there.
  const cloudOnly = isAndroidCloudBuild();

  const actions = useMemo<RuntimeAction[]>(() => {
    const base: RuntimeAction[] = [
      {
        target: "cloud",
        label: t("settings.runtime.cloudLabel", {
          defaultValue: "Cloud agent",
        }),
        icon: Cloud,
      },
    ];
    if (!cloudOnly) {
      base.push({
        target: "local",
        label: t("settings.runtime.localLabel", {
          defaultValue: "Local",
        }),
        icon: Laptop,
        disabled: storeBuild,
        disabledReason: localDisabledReason,
      });
    }
    base.push({
      target: "remote",
      label: t("settings.runtime.remoteLabel", {
        defaultValue: "Remote",
      }),
      icon: RadioTower,
    });
    return base;
  }, [t, cloudOnly, storeBuild, localDisabledReason]);

  const handleSwitch = useCallback((target: FirstRunReloadTarget) => {
    // Cloud/local re-enter the first-run runtime picker. Remote no longer routes
    // through first-run (post-#9952 there is no remote URL capture there);
    // instead it reveals an inline "connect a remote agent" form that points the
    // app straight at a host via the hardened CONNECT_EVENT path.
    if (target === "remote") {
      setRemoteError(null);
      setRemoteFormOpen((open) => !open);
      return;
    }
    reloadIntoFirstRunRuntime(target);
  }, []);

  const handleConnectRemote = useCallback(() => {
    let normalized: string;
    try {
      normalized = normalizeRemoteAgentUrl(remoteUrl);
    } catch (error) {
      setRemoteError(
        error instanceof Error
          ? error.message
          : t("settings.runtime.remoteInvalidUrl", {
              defaultValue: "Enter a valid remote agent URL.",
            }),
      );
      return;
    }
    setRemoteError(null);
    // skipConfirm: the user explicitly typed this URL in trusted Settings, so the
    // OS-deep-link confirmation prompt is redundant. completeFirstRun: adopt the
    // remote as the active runtime and land on home.
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: normalized,
      token: remoteToken.trim() || undefined,
      completeFirstRun: true,
      skipConfirm: true,
    });
  }, [remoteUrl, remoteToken, t]);

  const handleImportDirectState = useCallback(async () => {
    setMigrationBusy(true);
    setMigrationMessage(null);
    try {
      const existing = await inspectExistingElizaInstall();
      const picked = await pickDesktopWorkspaceFolder({
        defaultPath: existing?.stateDir,
        promptTitle: t("settings.runtime.importDirectStatePickerTitle", {
          defaultValue: "Choose direct-build data folder",
        }),
      });
      if (!picked || picked.canceled || !picked.path) {
        setMigrationMessage(
          t("settings.runtime.importDirectStateCanceled", {
            defaultValue: "Import canceled.",
          }),
        );
        return;
      }
      const result = await migrateDesktopStateDir(picked.path);
      if (!result) {
        setMigrationMessage(
          t("settings.runtime.importDirectStateUnavailable", {
            defaultValue: "Import is unavailable in this runtime.",
          }),
        );
        return;
      }
      if (!result.ok) {
        setMigrationMessage(
          t("settings.runtime.importDirectStateFailed", {
            defaultValue: "Import failed: {{error}}",
            error: result.error ?? "unknown error",
          }),
        );
        return;
      }
      if (!result.migrated) {
        setMigrationMessage(
          t("settings.runtime.importDirectStateSkipped", {
            defaultValue: "Nothing was imported from that folder.",
          }),
        );
        return;
      }
      setMigrationMessage(
        t("settings.runtime.importDirectStateDone", {
          defaultValue: "Imported direct-build data into this sandboxed build.",
        }),
      );
    } catch (error) {
      setMigrationMessage(
        t("settings.runtime.importDirectStateFailed", {
          defaultValue: "Import failed: {{error}}",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setMigrationBusy(false);
    }
  }, [t]);

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.runtime.modeGroupTitle", {
          defaultValue: "Runtime",
        })}
        description={t("settings.runtime.currentMode", {
          defaultValue: "Current mode: {{mode}}",
          mode: currentRuntime.label,
        })}
      >
        {actions.map((action) => {
          const active = currentRuntime.kind === action.target;
          const disabled = action.disabled === true;
          return (
            <RuntimeModeRow
              key={action.target}
              target={action.target}
              icon={action.icon}
              label={action.label}
              description={disabled ? action.disabledReason : undefined}
              active={active}
              disabled={disabled}
              onSelect={() => handleSwitch(action.target)}
            />
          );
        })}

        {remoteFormOpen ? (
          <SettingsRow
            label={t("settings.runtime.remoteConnectLabel", {
              defaultValue: "Connect a remote agent",
            })}
            description={t("settings.runtime.remoteConnectHelp", {
              defaultValue:
                "Enter the agent's URL — add an access token only if the host requires one.",
            })}
            stacked
          >
            <div className="flex flex-col gap-2">
              <Input
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={remoteUrl}
                onChange={(event) => {
                  setRemoteUrl(event.target.value);
                  setRemoteError(null);
                }}
                placeholder="https://agent.example.com"
                hasError={Boolean(remoteError)}
                data-testid="settings-remote-address"
                aria-label={t("settings.runtime.remoteConnectLabel", {
                  defaultValue: "Connect a remote agent",
                })}
              />
              <Input
                type="password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={remoteToken}
                onChange={(event) => setRemoteToken(event.target.value)}
                placeholder={t("settings.runtime.remoteTokenPlaceholder", {
                  defaultValue: "Access token (optional)",
                })}
                data-testid="settings-remote-token"
                aria-label={t("settings.runtime.remoteTokenPlaceholder", {
                  defaultValue: "Access token (optional)",
                })}
              />
              {remoteError ? (
                <p className="text-xs text-destructive" role="alert">
                  {remoteError}
                </p>
              ) : null}
              <SettingsActionButton
                agentId="runtime-connect-remote"
                agentLabel={t("settings.runtime.remoteConnectAction", {
                  defaultValue: "Connect",
                })}
                type="button"
                onClick={handleConnectRemote}
                disabled={!remoteUrl.trim()}
                className="h-11 w-fit rounded-md px-4 text-sm"
                data-testid="settings-remote-connect"
              >
                {t("settings.runtime.remoteConnectAction", {
                  defaultValue: "Connect",
                })}
              </SettingsActionButton>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      {/* The default surface is the runtime-mode picker above. The one-time
          sandbox-import migration is an expert operation, so it lives behind the
          shared advanced toggle rather than cluttering a fresh user's view. */}
      {storeBuild ? (
        <SettingsGroup>
          <SettingsRow
            label={t("settings.advanced", { defaultValue: "Advanced" })}
            control={<AdvancedToggle label="Advanced" />}
          />
        </SettingsGroup>
      ) : null}

      {storeBuild && advancedEnabled ? (
        <SettingsGroup
          title={t("settings.runtime.sandboxGroupTitle", {
            defaultValue: "Sandbox build",
          })}
          footer={
            <a
              href={STORE_LOCAL_DISABLED_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              {t("settings.runtime.localDisabledStoreLink", {
                defaultValue: "Why is local disabled?",
              })}
            </a>
          }
        >
          {isElectrobunRuntime() ? (
            <SettingsRow
              label={t("settings.runtime.importDirectState", {
                defaultValue: "Import direct-build data",
              })}
              description={migrationMessage ?? undefined}
              stacked
            >
              <SettingsActionButton
                agentId="runtime-import-direct-state"
                agentLabel={t("settings.runtime.importDirectState", {
                  defaultValue: "Import direct-build data",
                })}
                agentStatus={migrationBusy ? "busy" : undefined}
                type="button"
                variant="outline"
                onClick={() => void handleImportDirectState()}
                disabled={migrationBusy}
                className="h-11 w-fit rounded-md px-4 text-sm"
              >
                {migrationBusy
                  ? t("settings.runtime.importingDirectState", {
                      defaultValue: "Importing…",
                    })
                  : t("settings.runtime.importDirectState", {
                      defaultValue: "Import direct-build data",
                    })}
              </SettingsActionButton>
            </SettingsRow>
          ) : (
            <SettingsRow
              label={t("settings.runtime.sandboxNote", {
                defaultValue: "Local agent is unavailable in this build.",
              })}
            />
          )}
        </SettingsGroup>
      ) : null}
    </SettingsStack>
  );
}
