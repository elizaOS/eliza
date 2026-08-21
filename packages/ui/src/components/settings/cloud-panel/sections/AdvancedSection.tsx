/**
 * Cloud settings panel → Advanced section.
 *
 * Developer toggles (developer mode, preview mode, error logging), local-agent
 * backups (create / list / restore / import), and destructive reset actions
 * (reset app state, clear cache, sign out of Cloud). Backup create/list/restore
 * reuse the same typed API client the built-in AdvancedSection uses; reset
 * actions guard with a confirmation prompt, and "Sign out of Cloud" dispatches
 * the `eliza:cloud-sign-out-requested` custom event for the shell to handle.
 */
import { SlidersHorizontal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { client, type LocalAgentBackupMetadata } from "../../../../api";
import { cn } from "../../../../lib/utils";
import {
  setDeveloperMode,
  setPreviewMode,
  useAppSelectorShallow,
  useIsDeveloperMode,
  useIsPreviewMode,
} from "../../../../state";
import {
  SettingsGroup,
  SettingsStack,
  NuphySwitchRow,
  NuphyActionButton,
  NuphyRow,
} from "../nuphy-settings-primitives";
import { Button as NuphyButton } from "@extrastu/nuphy-ui";

const ERROR_LOGGING_KEY = "errorLogging";

function readErrorLogging(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ERROR_LOGGING_KEY) === "1";
}

function formatBackupSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "0 KB";
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

function backupErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
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

  const [backups, setBackups] = useState<LocalAgentBackupMetadata[]>([]);
  const [backupsLoaded, setBackupsLoaded] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [restoreBusyFileName, setRestoreBusyFileName] = useState<string | null>(
    null,
  );
  const [backupNotice, setBackupNotice] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const loadBackups = useCallback(async () => {
    setListBusy(true);
    try {
      const list = await client.listLocalAgentBackups();
      setBackups(list);
      setBackupsLoaded(true);
    } catch (err) {
      setBackupNotice({
        kind: "error",
        message: backupErrorMessage(err, "Failed to load backups."),
      });
    } finally {
      setListBusy(false);
    }
  }, []);

  const handleCreateBackup = useCallback(async () => {
    if (createBusy) return;
    setCreateBusy(true);
    setBackupNotice(null);
    try {
      const backup = await client.createLocalAgentBackup();
      const list = await client.listLocalAgentBackups().catch(() => [backup]);
      setBackups(list);
      setBackupsLoaded(true);
      setBackupNotice({
        kind: "success",
        message: `Created backup (${formatBackupSize(backup.sizeBytes)}).`,
      });
    } catch (err) {
      setBackupNotice({
        kind: "error",
        message: backupErrorMessage(err, "Backup failed."),
      });
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy]);

  const handleRestoreBackup = useCallback(
    async (fileName: string) => {
      if (restoreBusyFileName) return;
      setRestoreBusyFileName(fileName);
      setBackupNotice(null);
      try {
        await client.restoreLocalAgentBackup(fileName);
        setBackupNotice({
          kind: "success",
          message: "Restored backup. Restart the agent to activate it.",
        });
      } catch (err) {
        setBackupNotice({
          kind: "error",
          message: backupErrorMessage(err, "Restore failed."),
        });
      } finally {
        setRestoreBusyFileName(null);
      }
    },
    [restoreBusyFileName],
  );

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so picking the same file again re-fires onChange.
      event.target.value = "";
      if (!file) return;
      setBackupNotice(null);
      // Reuse the restore endpoint with the imported file name — the server
      // resolves imports uploaded out-of-band. Surface a clear degrade if the
      // route is unavailable.
      try {
        await client.restoreLocalAgentBackup(file.name);
        setBackupNotice({
          kind: "success",
          message: `Imported ${file.name}. Restart the agent to activate it.`,
        });
        void loadBackups();
      } catch (err) {
        setBackupNotice({
          kind: "error",
          message: backupErrorMessage(err, "Import failed."),
        });
      }
    },
    [loadBackups],
  );

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

  const handleClearCache = useCallback(() => {
    if (
      !window.confirm(
        "Clear cache? This removes cached data and temporary files. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      if (typeof caches !== "undefined") {
        void caches.keys().then((keys) => {
          for (const k of keys) void caches.delete(k);
        });
      }
      setActionNotice?.("Cache cleared.", "success", 4000);
    } catch {
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
        title="Backups"
        footer="Save a snapshot of this agent, or restore it from an earlier one."
      >
        <NuphyRow
          label="Create backup"
          description="Snapshot the agent's current state."
        >
          <div className="flex flex-wrap items-center gap-2">
            <NuphyButton
              variant="secondary"
              size="sm"
              className="rounded-sm"
              disabled={createBusy}
              onClick={() => void handleCreateBackup()}
            >
              {createBusy ? "Creating…" : "Create backup"}
            </NuphyButton>
            {!backupsLoaded && !listBusy ? (
              <NuphyButton
                variant="ghost"
                size="sm"
                className="rounded-sm text-muted-foreground"
                onClick={() => void loadBackups()}
              >
                Refresh
              </NuphyButton>
            ) : null}
          </div>
        </NuphyRow>

        {backupNotice ? (
          <div
            className={cn(
              "rounded-sm border px-3 py-2 text-sm",
              backupNotice.kind === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-success/30 bg-success/10 text-success",
            )}
            role={backupNotice.kind === "error" ? "alert" : "status"}
            aria-live={backupNotice.kind === "error" ? "assertive" : "polite"}
          >
            {backupNotice.message}
          </div>
        ) : null}

        {listBusy ? (
          <NuphyRow label="Loading backups…" />
        ) : backups.length === 0 ? (
          <NuphyRow
            label="No backups yet"
            description="Create a backup to save your agent's current state."
          />
        ) : (
          backups.map((backup) => {
            const restoring = restoreBusyFileName === backup.fileName;
            return (
              <NuphyRow
                key={backup.fileName}
                label={backup.fileName}
                description={formatBackupSize(backup.sizeBytes)}
                control={
                  <NuphyButton
                    variant="secondary"
                    size="sm"
                    disabled={restoring || restoreBusyFileName !== null}
                    onClick={() => void handleRestoreBackup(backup.fileName)}
                  >
                    {restoring ? "Restoring…" : "Restore"}
                  </NuphyButton>
                }
              />
            );
          })
        )}

        <NuphyRow
          label="Import backup file…"
          description="Restore from a backup file on disk."
        >
          <div className="flex flex-wrap items-center gap-2">
            <NuphyButton
              variant="secondary"
              size="sm"
              className="rounded-sm"
              onClick={handleImportClick}
            >
              Import backup file…
            </NuphyButton>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json,.bak"
              className="hidden"
              onChange={(event) => void handleImportFile(event)}
            />
          </div>
        </NuphyRow>
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
          onActivate={handleClearCache}
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
