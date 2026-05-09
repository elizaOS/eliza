/**
 * Runtime Settings Section — only rendered on the ElizaOS variant.
 *
 * ElizaOS bypasses the RuntimeGate "Choose your setup" picker on first
 * launch (the device IS the agent). This section is the deliberate
 * escape hatch: it lets the user switch out of the default on-device
 * agent into Eliza Cloud or a Remote Mac.
 *
 * The actual storage clear + URL navigation is in
 * `onboarding/reload-into-runtime-picker.ts` — kept as a leaf module so
 * its contract is testable without booting the SettingsView dependency
 * graph.
 *
 * The vanilla Android APK never enters this section — `isElizaOS()` is
 * false there, so users on a stock device pick their runtime through the
 * regular picker flow on first launch and don't need this surface.
 */

import { Button } from "@elizaos/ui";
import { useCallback } from "react";
import { reloadIntoRuntimePicker } from "../../onboarding/reload-into-runtime-picker";
import { useApp } from "../../state";

export function RuntimeSettingsSection() {
  const { t } = useApp();

  const handleSwitch = useCallback(() => {
    reloadIntoRuntimePicker();
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5">
      <p className="text-sm text-foreground/80">
        {t("settings.runtime.localActiveDescription", {
          defaultValue:
            "This device runs the on-device agent. Switch to Eliza Cloud or a Remote Mac to route the UI to a different agent.",
        })}
      </p>
      <div>
        <Button onClick={handleSwitch} variant="default" size="sm">
          {t("settings.runtime.switchButton", {
            defaultValue: "Switch runtime…",
          })}
        </Button>
      </div>
      <p className="text-xs text-foreground/60">
        {t("settings.runtime.switchNote", {
          defaultValue:
            "Switching reopens the runtime picker. Your current chat history stays on the device.",
        })}
      </p>
    </div>
  );
}
