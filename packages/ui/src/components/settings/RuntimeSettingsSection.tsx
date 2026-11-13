/**
 * Settings → Runtime section (the `runtime` section id). Shows where the agent
 * currently runs (local / remote / cloud, from `GET /api/runtime/mode` with a
 * local heuristic fallback) and points runtime switching to the canonical
 * My Runtimes section.
 */

import { Server } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { isStoreBuild } from "../../build-variant";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import {
  type AgentRuntimeTargetKind,
  inferAgentRuntimeTarget,
} from "../../state/agent-runtime-target";
import { useAppSelector } from "../../state/app-store";
import { loadPersistedActiveServer } from "../../state/persistence";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
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
  const handleOpenMyRuntimes = useCallback(() => {
    openSettingsSection(MY_RUNTIMES_SECTION_ID);
  }, []);
  const { ref: manageRuntimesRef, agentProps: manageRuntimesAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "runtime-manage-runtimes",
      role: "button",
      label: "My Runtimes",
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
            defaultValue: "My Runtimes",
          })}
          description={t("settings.runtime.manageRuntimesHelp", {
            defaultValue: "Saved local, cloud, and remote agents.",
          })}
          onClick={handleOpenMyRuntimes}
          buttonRef={manageRuntimesRef}
          buttonProps={manageRuntimesAgentProps}
        />
      </SettingsGroup>

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
          <SettingsRow
            label={t("settings.runtime.sandboxNote", {
              defaultValue: "Local agent is unavailable in this build.",
            })}
          />
        </SettingsGroup>
      ) : null}
    </SettingsStack>
  );
}
