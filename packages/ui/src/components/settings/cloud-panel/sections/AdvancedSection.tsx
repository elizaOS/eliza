/**
 * Cloud settings panel → Advanced section.
 *
 * Developer toggles and destructive reset actions (reset app state, clear
 * cache, sign out of Cloud). Local-agent backups are deliberately absent from
 * this cloud-only surface. Reset actions guard with a confirmation prompt and
 * only touch elizaOS-owned storage; "Sign out of Cloud" calls the shared
 * `handleCloudSignOut` boundary and reports success only after it resolves.
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
  CloudActionButton,
  CloudSwitchRow,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";

const ERROR_LOGGING_KEY = "errorLogging";

/**
 * elizaOS-owned Web Storage key prefixes and legacy unprefixed keys. Reset
 * must only delete state this app wrote — on a shared origin (hosted shells,
 * SSO-bridged hosts) blanket `.clear()` would destroy unrelated auth and
 * application state that the UI copy never promised to touch.
 */
const ELIZA_STORAGE_PREFIXES = [
  "eliza:",
  "eliza.",
  "eliza-",
  "eliza_",
  "elizaos",
  "steward_",
  "pendant:",
] as const;
const ELIZA_LEGACY_STORAGE_KEYS = [
  ERROR_LOGGING_KEY,
  "pluginOrder",
  "plugin.pref",
  "cloud.lang",
] as const;

function isElizaOwnedStorageKey(key: string): boolean {
  return (
    ELIZA_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    (ELIZA_LEGACY_STORAGE_KEYS as readonly string[]).includes(key)
  );
}

function removeElizaOwnedKeys(storage: Storage): void {
  const owned: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && isElizaOwnedStorageKey(key)) owned.push(key);
  }
  for (const key of owned) storage.removeItem(key);
}

function readErrorLogging(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ERROR_LOGGING_KEY) === "1";
}

export function AdvancedSection() {
  const { setActionNotice, handleCloudSignOut } = useAppSelectorShallow(
    (s) => ({
      setActionNotice: s.setActionNotice,
      handleCloudSignOut: s.handleCloudSignOut,
    }),
  );
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
        removeElizaOwnedKeys(window.localStorage);
        removeElizaOwnedKeys(window.sessionStorage);
      }
      setDeveloperMode(false);
      setPreviewMode(false);
      setErrorLogging(false);
      setActionNotice?.("App state reset. Reload to finish.", "success", 5000);
    } catch {
      // error-policy:J4 reset failure is reported as a visible error.
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
        // Same-origin CacheStorage may hold entries owned by other software
        // (service workers, host shells); only delete elizaOS-named caches.
        const keys = await caches.keys();
        const ownedKeys = keys.filter((key) => isElizaOwnedStorageKey(key));
        const deleted = await Promise.all(
          ownedKeys.map((key) => caches.delete(key)),
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

  const handleSignOut = useCallback(async () => {
    if (
      !window.confirm(
        "Sign out of Eliza Cloud? You will need to sign in again to use cloud features.",
      )
    ) {
      return;
    }
    try {
      await handleCloudSignOut();
      setActionNotice?.("Signed out of Eliza Cloud.", "success", 5000);
    } catch {
      // error-policy:J4 sign-out failure stays visible; session state is unchanged.
      setActionNotice?.("Could not sign out of Eliza Cloud.", "error", 5000);
    }
  }, [handleCloudSignOut, setActionNotice]);

  return (
    <SettingsStack>
      <SettingsGroup
        title="Developer"
        footer="Toggle hidden views and diagnostic logging."
      >
        <CloudSwitchRow
          agentId="cloud-developer-mode"
          group="cloud-advanced"
          icon={SlidersHorizontal}
          label="Developer mode"
          description="Reveal developer tooling — logs, database, trajectories."
          checked={developerMode}
          onCheckedChange={(checked) => setDeveloperMode(checked)}
        />
        <CloudSwitchRow
          agentId="cloud-preview-mode"
          group="cloud-advanced"
          label="Preview mode"
          description="Show unfinished, alpha, or experimental views."
          checked={previewMode}
          onCheckedChange={(checked) => setPreviewMode(checked)}
        />
        <CloudSwitchRow
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
        <CloudActionButton
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
        <CloudActionButton
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
        <CloudActionButton
          agentId="cloud-sign-out"
          group="cloud-advanced"
          agentLabel="Sign out of Cloud"
          label="Sign out of Cloud"
          description="Disconnect your Eliza Cloud session."
          buttonLabel="Sign out of Cloud"
          variant="destructive"
          size="sm"
          onActivate={() => void handleSignOut()}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
