/**
 * Cloud settings panel → Advanced section.
 *
 * Developer toggles and destructive reset actions (reset app state, clear
 * cache, sign out of Cloud). Local-agent backups are deliberately absent from
 * this cloud-only surface. Reset actions guard with a confirmation prompt, and
 * "Sign out of Cloud" dispatches
 * the `eliza:cloud-sign-out-requested` custom event for the shell to handle.
 */
import { SlidersHorizontal } from "lucide-react";
import { useCallback, useState } from "react";
import {
  setDeveloperMode,
  setPreviewMode,
  useAppSelectorShallow,
  useIsDeveloperMode,
  useIsPreviewMode,
} from "../../../../state";
import {
  NuphyActionButton,
  NuphySwitchRow,
  SettingsGroup,
  SettingsStack,
} from "../nuphy-settings-primitives";

const ERROR_LOGGING_KEY = "errorLogging";

function readErrorLogging(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ERROR_LOGGING_KEY) === "1";
}

function dispatchCloudSignOut(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("eliza:cloud-sign-out-requested"));
}

export function AdvancedSection() {
  const { setActionNotice } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
  }));
  const developerMode = useIsDeveloperMode();
  const previewMode = useIsPreviewMode();
  const [errorLogging, setErrorLogging] = useState<boolean>(readErrorLogging);

  const handleToggleErrorLogging = useCallback((checked: boolean) => {
    setErrorLogging(checked);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ERROR_LOGGING_KEY, checked ? "1" : "0");
    }
  }, []);

  const handleResetAppState = useCallback(() => {
    if (
      !window.confirm(
        "Reset app state? This clears local preferences and restores defaults. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      if (typeof window !== "undefined") {
        window.localStorage.clear();
        window.sessionStorage.clear();
      }
      setDeveloperMode(false);
      setPreviewMode(false);
      setErrorLogging(false);
      setActionNotice?.("App state reset. Reload to finish.", "success", 5000);
    } catch {
      setActionNotice?.("Could not reset app state.", "error", 5000);
    }
  }, [setActionNotice]);

  const handleClearCache = useCallback(async () => {
    if (
      !window.confirm(
        "Clear cache? This removes cached data and temporary files. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        const deleted = await Promise.all(
          keys.map((key) => caches.delete(key)),
        );
        if (deleted.some((result) => !result)) {
          throw new Error("A cache could not be deleted.");
        }
      }
      setActionNotice?.("Cache cleared.", "success", 4000);
    } catch {
      // error-policy:J4 Cache deletion failure is reported as a visible error.
      setActionNotice?.("Could not clear cache.", "error", 4000);
    }
  }, [setActionNotice]);

  const handleSignOut = useCallback(() => {
    if (
      !window.confirm(
        "Sign out of Eliza Cloud? You will need to sign in again to use cloud features.",
      )
    ) {
      return;
    }
    dispatchCloudSignOut();
    setActionNotice?.("Signed out of Eliza Cloud.", "success", 5000);
  }, [setActionNotice]);

  return (
    <SettingsStack>
      <SettingsGroup
        title="Developer"
        footer="Toggle hidden views and diagnostic logging."
      >
        <NuphySwitchRow
          agentId="cloud-developer-mode"
          group="cloud-advanced"
          icon={SlidersHorizontal}
          label="Developer mode"
          description="Reveal developer tooling — logs, database, trajectories."
          checked={developerMode}
          onCheckedChange={(checked) => setDeveloperMode(checked)}
        />
        <NuphySwitchRow
          agentId="cloud-preview-mode"
          group="cloud-advanced"
          label="Preview mode"
          description="Show unfinished, alpha, or experimental views."
          checked={previewMode}
          onCheckedChange={(checked) => setPreviewMode(checked)}
        />
        <NuphySwitchRow
          agentId="cloud-error-logging"
          group="cloud-advanced"
          label="Error logging"
          description="Record client-side errors for diagnostics."
          checked={errorLogging}
          onCheckedChange={handleToggleErrorLogging}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Reset"
        footer="Destructive actions. These cannot be undone."
      >
        <NuphyActionButton
          agentId="cloud-reset-app-state"
          group="cloud-advanced"
          agentLabel="Reset app state"
          label="Reset app state"
          description="Clear local preferences and restore defaults."
          buttonLabel="Reset app state"
          variant="destructive"
          size="sm"
          onActivate={handleResetAppState}
        />
        <NuphyActionButton
          agentId="cloud-clear-cache"
          group="cloud-advanced"
          agentLabel="Clear cache"
          label="Clear cache"
          description="Remove cached data and temporary files."
          buttonLabel="Clear cache"
          variant="destructive"
          size="sm"
          onActivate={() => void handleClearCache()}
        />
        <NuphyActionButton
          agentId="cloud-sign-out"
          group="cloud-advanced"
          agentLabel="Sign out of Cloud"
          label="Sign out of Cloud"
          description="Disconnect your Eliza Cloud session."
          buttonLabel="Sign out of Cloud"
          variant="destructive"
          size="sm"
          onActivate={handleSignOut}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
