import { AlertTriangle, Download, Trash2, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client, type LocalAgentBackupMetadata } from "../../api";
import {
  setDeveloperMode,
  setPreviewMode,
  useAppSelectorShallow,
  useIsDeveloperMode,
  useIsPreviewMode,
} from "../../state";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsActionButton, SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

function formatBackupDate(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
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

function backupOptionInputId(fileName: string): string {
  return `agent-backup-file-${fileName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function BackupOptionList({
  backups,
  selectedFileName,
  onSelect,
}: {
  backups: LocalAgentBackupMetadata[];
  selectedFileName: string;
  onSelect: (fileName: string) => void;
}) {
  if (backups.length === 0) {
    return (
      <div className="rounded-sm border border-line bg-bg px-3 py-2 text-sm text-muted">
        No backups yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-sm border border-line bg-bg">
      {backups.map((backup) => {
        const inputId = backupOptionInputId(backup.fileName);
        return (
          <label
            key={backup.fileName}
            htmlFor={inputId}
            className="flex min-h-[3.25rem] cursor-pointer items-center gap-3 border-line border-t px-3 py-2 first:border-t-0"
          >
            <Input
              id={inputId}
              type="radio"
              name="agent-backup-file"
              className="h-4 w-4 shrink-0 border-border p-0 accent-current"
              checked={selectedFileName === backup.fileName}
              onChange={() => onSelect(backup.fileName)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-txt-strong">
                {formatBackupDate(backup.createdAt)}
              </span>
              <span className="block truncate text-xs text-muted">
                {formatBackupSize(backup.sizeBytes)} ·{" "}
                {backup.stateSha256.slice(0, 12)}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function AdvancedSection() {
  const { t, handleReset } = useAppSelectorShallow((s) => ({
    t: s.t,
    handleReset: s.handleReset,
  }));
  const developerMode = useIsDeveloperMode();
  const previewMode = useIsPreviewMode();
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [backupList, setBackupList] = useState<LocalAgentBackupMetadata[]>([]);
  const [selectedBackupFileName, setSelectedBackupFileName] = useState("");
  const [backupListBusy, setBackupListBusy] = useState(false);
  const [createBackupBusy, setCreateBackupBusy] = useState(false);
  const [restoreBackupBusy, setRestoreBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  const selectNewestBackup = useCallback(
    (backups: LocalAgentBackupMetadata[]) => {
      setSelectedBackupFileName((current) => {
        if (current && backups.some((backup) => backup.fileName === current)) {
          return current;
        }
        return backups[0]?.fileName ?? "";
      });
    },
    [],
  );

  const loadLocalBackups = useCallback(
    async (target: "backup" | "restore") => {
      setBackupListBusy(true);
      try {
        const backups = await client.listLocalAgentBackups();
        setBackupList(backups);
        selectNewestBackup(backups);
      } catch (err) {
        const message = backupErrorMessage(err, "Failed to load backups.");
        if (target === "restore") setRestoreError(message);
        else setBackupError(message);
      } finally {
        setBackupListBusy(false);
      }
    },
    [selectNewestBackup],
  );

  const openExportModal = useCallback(() => {
    setBackupError(null);
    setBackupSuccess(null);
    setExportModalOpen(true);
    void loadLocalBackups("backup");
  }, [loadLocalBackups]);

  const closeExportModal = useCallback(() => {
    setExportModalOpen(false);
    setBackupError(null);
    setBackupSuccess(null);
  }, []);

  const openImportModal = useCallback(() => {
    setRestoreError(null);
    setRestoreSuccess(null);
    setImportModalOpen(true);
    void loadLocalBackups("restore");
  }, [loadLocalBackups]);

  const closeImportModal = useCallback(() => {
    setImportModalOpen(false);
    setRestoreError(null);
    setRestoreSuccess(null);
  }, []);

  const handleCreateBackup = useCallback(async () => {
    if (createBackupBusy) return;
    setCreateBackupBusy(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const backup = await client.createLocalAgentBackup();
      const backups = await client
        .listLocalAgentBackups()
        .catch(() => [backup]);
      setBackupList(backups);
      setSelectedBackupFileName(backup.fileName);
      setBackupSuccess(
        `Created backup ${formatBackupDate(backup.createdAt)} (${formatBackupSize(
          backup.sizeBytes,
        )}).`,
      );
    } catch (err) {
      setBackupError(backupErrorMessage(err, "Backup failed."));
    } finally {
      setCreateBackupBusy(false);
    }
  }, [createBackupBusy]);

  const handleRestoreBackup = useCallback(async () => {
    if (restoreBackupBusy) return;
    if (!selectedBackupFileName) {
      setRestoreError("Select a backup before restoring.");
      setRestoreSuccess(null);
      return;
    }
    setRestoreBackupBusy(true);
    setRestoreError(null);
    setRestoreSuccess(null);
    try {
      await client.restoreLocalAgentBackup(selectedBackupFileName);
      setRestoreSuccess("Restored backup. Restart the agent to activate it.");
    } catch (err) {
      setRestoreError(backupErrorMessage(err, "Restore failed."));
    } finally {
      setRestoreBackupBusy(false);
    }
  }, [restoreBackupBusy, selectedBackupFileName]);

  const { ref: exportOpenRef, agentProps: exportOpenAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-export-open",
      role: "button",
      label: "Back Up Agent",
      group: "advanced",
      onActivate: openExportModal,
    });
  const { ref: importOpenRef, agentProps: importOpenAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-import-open",
      role: "button",
      label: "Restore Agent",
      group: "advanced",
      onActivate: openImportModal,
    });
  const { ref: resetOpenRef, agentProps: resetOpenAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-reset-open",
      role: "button",
      label: t("settings.resetEverything"),
      group: "advanced",
      onActivate: () => setResetConfirmOpen(true),
    });
  const { ref: exportSubmitRef, agentProps: exportSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-export-submit",
      role: "button",
      label: "Create Backup",
      group: "advanced-export",
      status: createBackupBusy ? "inactive" : "active",
      onActivate: () => void handleCreateBackup(),
    });
  const { ref: importSubmitRef, agentProps: importSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-import-submit",
      role: "button",
      label: "Restore Backup",
      group: "advanced-import",
      status:
        restoreBackupBusy || !selectedBackupFileName ? "inactive" : "active",
      onActivate: () => void handleRestoreBackup(),
    });
  const { ref: resetConfirmRef, agentProps: resetConfirmAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-reset-confirm",
      role: "button",
      label: t("settings.resetConfirmAction"),
      group: "advanced-reset",
      onActivate: () => {
        setResetConfirmOpen(false);
        void handleReset();
      },
    });

  return (
    <>
      <SettingsStack>
        <SettingsGroup>
          <SettingsRow
            icon={Download}
            label="Back Up Agent"
            onClick={openExportModal}
            buttonRef={exportOpenRef}
            buttonProps={exportOpenAgentProps}
          />
          <SettingsRow
            icon={Upload}
            label="Restore Agent"
            onClick={openImportModal}
            buttonRef={importOpenRef}
            buttonProps={importOpenAgentProps}
          />
        </SettingsGroup>

        <SettingsGroup
          title="View visibility"
          description="Views are sorted into four kinds. System and Release views are always shown. Turn on the kinds below to reveal the rest."
        >
          <SettingsSwitchRow
            agentId="advanced-developer-mode"
            group="advanced"
            label="Developer views"
            description="Developer tooling to verify the app is working — logs, database, trajectories. Off by default on every build, dev included."
            checked={developerMode}
            onCheckedChange={(checked) => setDeveloperMode(checked)}
          />
          <SettingsSwitchRow
            agentId="advanced-preview-mode"
            group="advanced"
            label="Preview views"
            description="Unfinished, alpha, or experimental views still in progress. Off by default."
            checked={previewMode}
            onCheckedChange={(checked) => setPreviewMode(checked)}
          />
        </SettingsGroup>

        <SettingsGroup
          title={
            <span className="flex items-center gap-1.5 text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("settings.dangerZone")}
            </span>
          }
        >
          <SettingsRow
            icon={Trash2}
            tone="danger"
            label={t("settings.resetAgent")}
            description={t("settings.resetAgentHint")}
            stacked
          >
            <div className="flex sm:justify-end">
              <Button
                ref={resetOpenRef}
                variant="destructive"
                size="sm"
                className="w-full rounded-sm whitespace-nowrap sm:w-auto"
                aria-haspopup="dialog"
                onClick={() => setResetConfirmOpen(true)}
                {...resetOpenAgentProps}
              >
                {t("settings.resetEverything")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsStack>

      <Dialog
        open={exportModalOpen}
        onOpenChange={(open: boolean) => {
          if (!open) closeExportModal();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Back Up Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {backupListBusy ? (
              <div className="flex min-h-[3.25rem] items-center gap-2 rounded-sm border border-line bg-bg px-3 py-2 text-sm text-muted">
                <Spinner size={16} />
                Loading backups
              </div>
            ) : (
              <BackupOptionList
                backups={backupList}
                selectedFileName={selectedBackupFileName}
                onSelect={setSelectedBackupFileName}
              />
            )}

            {backupError && (
              <div
                className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                role="alert"
                aria-live="assertive"
              >
                {backupError}
              </div>
            )}
            {backupSuccess && (
              <div
                className="rounded-sm border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
                role="status"
                aria-live="polite"
              >
                {backupSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <SettingsActionButton
                agentId="backup-export-cancel"
                agentGroup="advanced-export"
                agentLabel={t("common.cancel")}
                variant="outline"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-sm"
                onClick={closeExportModal}
              >
                {t("common.cancel")}
              </SettingsActionButton>
              <Button
                ref={exportSubmitRef}
                variant="default"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-sm"
                disabled={createBackupBusy}
                onClick={() => void handleCreateBackup()}
                {...exportSubmitAgentProps}
              >
                {createBackupBusy && <Spinner size={16} />}
                Create Backup
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={importModalOpen}
        onOpenChange={(open: boolean) => {
          if (!open) closeImportModal();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {backupListBusy ? (
              <div className="flex min-h-[3.25rem] items-center gap-2 rounded-sm border border-line bg-bg px-3 py-2 text-sm text-muted">
                <Spinner size={16} />
                Loading backups
              </div>
            ) : (
              <BackupOptionList
                backups={backupList}
                selectedFileName={selectedBackupFileName}
                onSelect={setSelectedBackupFileName}
              />
            )}

            {restoreError && (
              <div
                className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                role="alert"
                aria-live="assertive"
              >
                {restoreError}
              </div>
            )}
            {restoreSuccess && (
              <div
                className="rounded-sm border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
                role="status"
                aria-live="polite"
              >
                {restoreSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <SettingsActionButton
                agentId="backup-import-cancel"
                agentGroup="advanced-import"
                agentLabel={t("common.cancel")}
                variant="outline"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-sm"
                onClick={closeImportModal}
              >
                {t("common.cancel")}
              </SettingsActionButton>
              <Button
                ref={importSubmitRef}
                variant="default"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-sm"
                disabled={restoreBackupBusy || !selectedBackupFileName}
                onClick={() => void handleRestoreBackup()}
                {...importSubmitAgentProps}
              >
                {restoreBackupBusy && <Spinner size={16} />}
                Restore Backup
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetConfirmOpen}
        onOpenChange={(open: boolean) => setResetConfirmOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-danger">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              {t("settings.resetConfirmTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p
              className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
              role="alert"
              aria-live="assertive"
            >
              {t("settings.resetConfirmBody")}
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <SettingsActionButton
                agentId="backup-reset-cancel"
                agentGroup="advanced-reset"
                agentLabel={t("common.cancel")}
                variant="outline"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-sm"
                onClick={() => setResetConfirmOpen(false)}
              >
                {t("common.cancel")}
              </SettingsActionButton>
              <Button
                ref={resetConfirmRef}
                variant="destructive"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-sm"
                onClick={() => {
                  setResetConfirmOpen(false);
                  void handleReset();
                }}
                {...resetConfirmAgentProps}
              >
                {t("settings.resetConfirmAction")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
