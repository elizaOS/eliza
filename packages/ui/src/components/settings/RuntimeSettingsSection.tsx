/**
 * Settings → Runtime section (the `runtime` section id). Shows where the agent
 * currently runs (local / remote / cloud, from `GET /api/runtime/mode` with a
 * local heuristic fallback) and points runtime switching to the canonical
 * Devices & Runtimes section. Store builds keep the one-time desktop-state import
 * behind Advanced because that is a migration tool, not a switcher.
 */

import { Server } from "lucide-react";
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
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import { useAppSelector } from "../../state";
import {
  type AgentRuntimeTargetKind,
  inferAgentRuntimeTarget,
} from "../../state/agent-runtime-target";
import { loadPersistedActiveServer } from "../../state/persistence";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

const STORE_LOCAL_DISABLED_DOCS_URL =
  "https://github.com/eliza-ai/eliza/blob/develop/docs/desktop/build-variants.md";
const MY_RUNTIMES_SECTION_ID = "my-runtimes";

function openSettingsSection(sectionId: string): void {
  if (typeof window === "undefined") return;
  const nextHash = `#${sectionId}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, "", nextHash);
  }
  window.dispatchEvent(new Event("hashchange"));
}

export function RuntimeSettingsSection() {
  const t = useAppSelector((s) => s.t);
  const { state: runtimeModeState } = useRuntimeMode();
  const advancedEnabled = useAdvancedSettingsEnabled();
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const handleOpenMyRuntimes = useCallback(() => {
    openSettingsSection(MY_RUNTIMES_SECTION_ID);
  }, []);
  const { ref: manageRuntimesRef, agentProps: manageRuntimesAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "runtime-manage-runtimes",
      role: "button",
      label: "Devices & Runtimes",
      description: "Open the canonical runtime list and switcher",
      group: "runtime",
      onActivate: handleOpenMyRuntimes,
    });

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
        <SettingsRow
          icon={Server}
          label={t("settings.runtime.manageRuntimesLabel", {
            defaultValue: "Devices & Runtimes",
          })}
          description={t("settings.runtime.manageRuntimesHelp", {
            defaultValue: "Saved local, cloud, and remote agents.",
          })}
          onClick={handleOpenMyRuntimes}
          buttonRef={manageRuntimesRef}
          buttonProps={manageRuntimesAgentProps}
        />
      </SettingsGroup>

      {/* The default surface is runtime status above. The one-time sandbox-import
          migration is an expert operation, so it lives behind the shared
          advanced toggle rather than cluttering a fresh user's view. */}
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
