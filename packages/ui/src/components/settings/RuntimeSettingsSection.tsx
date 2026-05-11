/**
 * Runtime Settings Section.
 *
 * The actual storage clear + URL navigation is in
 * `onboarding/reload-into-runtime-picker.ts` — kept as a leaf module so
 * its contract is testable without booting the SettingsView dependency
 * graph.
 */

import { Button } from "@elizaos/ui";
import { Cloud, Laptop, type LucideIcon, RadioTower } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  inspectExistingElizaInstall,
  migrateDesktopStateDir,
  pickDesktopWorkspaceFolder,
} from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { isStoreBuild } from "../../build-variant";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import { readPersistedMobileRuntimeMode } from "../../onboarding/mobile-runtime-mode";
import {
  type RuntimePickerTarget,
  reloadIntoRuntimePicker,
} from "../../onboarding/reload-into-runtime-picker";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useApp } from "../../state";
import {
  type AgentRuntimeTargetKind,
  inferAgentRuntimeTarget,
} from "../../state/agent-runtime-target";
import { loadPersistedActiveServer } from "../../state/persistence";

type RuntimeAction = {
  target: RuntimePickerTarget;
  label: string;
  description: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
};

const STORE_LOCAL_DISABLED_DOCS_URL =
  "https://github.com/milady-ai/milady/blob/develop/docs/desktop/build-variants.md";

export function RuntimeSettingsSection() {
  const { t } = useApp();
  const { state: runtimeModeState } = useRuntimeMode();
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);

  // Prefer the authoritative server snapshot (`GET /api/runtime/mode`).
  // Fall back to the local heuristic when the snapshot is loading or the
  // endpoint is unreachable — older builds and offline shells still need
  // a sensible label.
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

  // The Play-Store-compliant Android build (`build:android:cloud`) ships
  // without the on-device agent runtime, so the Local option must be
  // hidden — selecting it would point the renderer at a loopback agent
  // that physically isn't there. The default sideload Android build, the
  // AOSP system build, iOS, and desktop all keep the full picker.
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

  const handleSwitch = useCallback((target: RuntimePickerTarget) => {
    reloadIntoRuntimePicker(target);
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
    <div className="flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">
          {t("settings.runtime.currentMode", {
            defaultValue: "Current mode: {{mode}}",
            mode: currentRuntime.label,
          })}
        </div>
        <p className="text-sm text-foreground/70">
          {t("settings.runtime.description", {
            defaultValue:
              "Switch where the app sends agent requests. Reset Everything resets the currently selected agent.",
          })}
        </p>
      </div>
      <div
        className={
          actions.length === 2
            ? "grid gap-2 sm:grid-cols-2"
            : "grid gap-2 sm:grid-cols-3"
        }
      >
        {actions.map((action) => {
          const Icon = action.icon;
          const active = currentRuntime.kind === action.target;
          const disabled = action.disabled === true;
          return (
            <Button
              key={action.target}
              onClick={() => handleSwitch(action.target)}
              variant={active ? "default" : "outline"}
              size="sm"
              disabled={disabled}
              title={action.disabledReason}
              className="h-auto justify-start gap-2 px-3 py-2 text-left"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {action.label}
                </span>
                <span className="whitespace-normal text-xs opacity-70">
                  {action.description}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
      {storeBuild ? (
        <div className="space-y-2 text-xs text-foreground/60">
          <p>
            {t("settings.runtime.localDisabledStoreNote", {
              defaultValue:
                "This is the store-distributed build, which runs in a sandbox. ",
            })}
            <a
              href={STORE_LOCAL_DISABLED_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {t("settings.runtime.localDisabledStoreLink", {
                defaultValue: "Why?",
              })}
            </a>
          </p>
          {isElectrobunRuntime() ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleImportDirectState()}
                disabled={migrationBusy}
                className="w-fit"
              >
                {migrationBusy
                  ? t("settings.runtime.importingDirectState", {
                      defaultValue: "Importing...",
                    })
                  : t("settings.runtime.importDirectState", {
                      defaultValue: "Import direct-build data",
                    })}
              </Button>
              {migrationMessage ? <span>{migrationMessage}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-foreground/60">
        {t("settings.runtime.switchNote", {
          defaultValue:
            "Switching reopens the runtime picker and leaves each agent's own data on that agent.",
        })}
      </p>
    </div>
  );
}
