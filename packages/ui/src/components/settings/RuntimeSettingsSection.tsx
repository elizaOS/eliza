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
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import {
  type FirstRunReloadTarget,
  reloadIntoFirstRunRuntime,
} from "../../first-run/reload-into-first-run-runtime";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useApp } from "../../state";
import {
  type AgentRuntimeTargetKind,
  inferAgentRuntimeTarget,
} from "../../state/agent-runtime-target";
import { loadPersistedActiveServer } from "../../state/persistence";
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
  description: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
};

const STORE_LOCAL_DISABLED_DOCS_URL =
  "https://github.com/eliza-ai/eliza/blob/develop/docs/desktop/build-variants.md";

export function RuntimeSettingsSection() {
  const { t } = useApp();
  const { state: runtimeModeState } = useRuntimeMode();
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);

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
        description: t("settings.runtime.cloudDescription", {
          defaultValue: "Use an Eliza Cloud hosted agent.",
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
        description: t("settings.runtime.localDescription", {
          defaultValue: "Use the agent running on this device.",
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
      description: t("settings.runtime.remoteDescription", {
        defaultValue: "Connect to an agent on another machine.",
      }),
      icon: RadioTower,
    });
    return base;
  }, [t, cloudOnly, storeBuild, localDisabledReason]);

  const handleSwitch = useCallback((target: FirstRunReloadTarget) => {
    reloadIntoFirstRunRuntime(target);
  }, []);

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
              description={
                disabled ? action.disabledReason : action.description
              }
              active={active}
              disabled={disabled}
              onSelect={() => handleSwitch(action.target)}
            />
          );
        })}
      </SettingsGroup>

      {storeBuild ? (
        <SettingsGroup
          title={t("settings.runtime.sandboxGroupTitle", {
            defaultValue: "Sandbox build",
          })}
          footer={
            <>
              {t("settings.runtime.localDisabledStoreNote", {
                defaultValue: "This store build runs in a sandbox. ",
              })}
              <a
                href={STORE_LOCAL_DISABLED_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline"
              >
                {t("settings.runtime.localDisabledStoreLink", {
                  defaultValue: "Why?",
                })}
              </a>
            </>
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
