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
import { useCallback, useMemo } from "react";
import { readPersistedMobileRuntimeMode } from "../../onboarding/mobile-runtime-mode";
import {
  type RuntimePickerTarget,
  reloadIntoRuntimePicker,
} from "../../onboarding/reload-into-runtime-picker";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { useApp } from "../../state";
import { inferAgentRuntimeTarget } from "../../state/agent-runtime-target";
import { loadPersistedActiveServer } from "../../state/persistence";

type RuntimeAction = {
  target: RuntimePickerTarget;
  label: string;
  description: string;
  icon: LucideIcon;
};

export function RuntimeSettingsSection() {
  const { t } = useApp();

  const currentRuntime = useMemo(
    () =>
      inferAgentRuntimeTarget({
        activeServer: loadPersistedActiveServer(),
        mobileRuntimeMode: readPersistedMobileRuntimeMode(),
      }),
    [],
  );

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
  }, [t, cloudOnly]);

  const handleSwitch = useCallback((target: RuntimePickerTarget) => {
    reloadIntoRuntimePicker(target);
  }, []);

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
          return (
            <Button
              key={action.target}
              onClick={() => handleSwitch(action.target)}
              variant={active ? "default" : "outline"}
              size="sm"
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
      <p className="text-xs text-foreground/60">
        {t("settings.runtime.switchNote", {
          defaultValue:
            "Switching reopens the runtime picker and leaves each agent's own data on that agent.",
        })}
      </p>
    </div>
  );
}
