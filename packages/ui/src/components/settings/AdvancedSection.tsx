import { AlertTriangle, Download, Trash2, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { setDeveloperMode, useApp, useIsDeveloperMode } from "../../state";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { SettingsActionButton, SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

export function AdvancedSection() {
  const { t } = useApp();
  const {
    handleReset,
    exportBusy,
    exportPassword,
    exportIncludeLogs,
    exportError,
    exportSuccess,
    importBusy,
    importPassword,
    importFile,
    importError,
    importSuccess,
    handleAgentExport,
    handleAgentImport,
    setState,
  } = useApp();
  const developerMode = useIsDeveloperMode();
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const resetExportState = useCallback(() => {
    setState("exportPassword", "");
    setState("exportIncludeLogs", false);
    setState("exportError", null);
    setState("exportSuccess", null);
  }, [setState]);

  const resetImportState = useCallback(() => {
    if (importFileInputRef.current) {
      importFileInputRef.current.value = "";
    }
    setState("importPassword", "");
    setState("importFile", null);
    setState("importError", null);
    setState("importSuccess", null);
  }, [setState]);

  const openExportModal = useCallback(() => {
    resetExportState();
    setExportModalOpen(true);
  }, [resetExportState]);

  const closeExportModal = useCallback(() => {
    setExportModalOpen(false);
    resetExportState();
  }, [resetExportState]);

  const openImportModal = useCallback(() => {
    resetImportState();
    setImportModalOpen(true);
  }, [resetImportState]);

  const closeImportModal = useCallback(() => {
    setImportModalOpen(false);
    resetImportState();
  }, [resetImportState]);

  const { ref: exportOpenRef, agentProps: exportOpenAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-export-open",
      role: "button",
      label: t("settings.exportAgent"),
      group: "advanced",
      onActivate: openExportModal,
    });
  const { ref: importOpenRef, agentProps: importOpenAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-import-open",
      role: "button",
      label: t("settings.importAgent"),
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
  const { ref: exportPasswordRef, agentProps: exportPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "advanced-export-password",
      role: "text-input",
      label: t("settingsview.Password"),
      group: "advanced-export",
      getValue: () => exportPassword,
      onFill: (value) => setState("exportPassword", value),
    });
  const { ref: exportIncludeLogsRef, agentProps: exportIncludeLogsAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-export-include-logs",
      role: "toggle",
      label: t("settingsview.IncludeRecentLogs"),
      group: "advanced-export",
      status: exportIncludeLogs ? "active" : "inactive",
      onActivate: () => setState("exportIncludeLogs", !exportIncludeLogs),
    });
  const { ref: exportSubmitRef, agentProps: exportSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-export-submit",
      role: "button",
      label: t("common.export"),
      group: "advanced-export",
      status: exportBusy ? "inactive" : "active",
      onActivate: () => void handleAgentExport(),
    });
  const { ref: importBrowseRef, agentProps: importBrowseAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-import-browse",
      role: "button",
      label: t("settingsview.BackupFile"),
      group: "advanced-import",
      onActivate: () => importFileInputRef.current?.click(),
    });
  const { ref: importPasswordRef, agentProps: importPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "advanced-import-password",
      role: "text-input",
      label: t("settingsview.Password"),
      group: "advanced-import",
      getValue: () => importPassword,
      onFill: (value) => setState("importPassword", value),
    });
  const { ref: importSubmitRef, agentProps: importSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "advanced-import-submit",
      role: "button",
      label: t("settings.import"),
      group: "advanced-import",
      status: importBusy ? "inactive" : "active",
      onActivate: () => void handleAgentImport(),
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
        <SettingsGroup bare>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Button
              ref={exportOpenRef}
              variant="outline"
              type="button"
              onClick={openExportModal}
              className="min-h-[5.5rem] h-auto rounded-lg border border-border bg-card p-5 text-left transition-[border-color,background-color] group hover:border-accent"
              aria-haspopup="dialog"
              {...exportOpenAgentProps}
            >
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-border bg-surface p-3 transition-all group-hover:border-accent group-hover:bg-accent">
                <Download className="h-5 w-5 shrink-0 text-txt-strong transition-colors group-hover:text-accent-fg" />
              </div>
              <div>
                <div className="font-medium text-sm">
                  {t("settings.exportAgent")}
                </div>
              </div>
            </Button>

            <Button
              ref={importOpenRef}
              variant="outline"
              type="button"
              onClick={openImportModal}
              className="min-h-[5.5rem] h-auto rounded-lg border border-border bg-card p-5 text-left transition-[border-color,background-color] group hover:border-accent"
              aria-haspopup="dialog"
              {...importOpenAgentProps}
            >
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-border bg-surface p-3 transition-all group-hover:border-accent group-hover:bg-accent">
                <Upload className="h-5 w-5 shrink-0 text-txt-strong transition-colors group-hover:text-accent-fg" />
              </div>
              <div>
                <div className="font-medium text-sm">
                  {t("settings.importAgent")}
                </div>
              </div>
            </Button>
          </div>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsSwitchRow
            agentId="advanced-developer-mode"
            group="advanced"
            label="Developer Mode"
            description="Show developer tools (logs, trajectory viewer, prompt artifacts) and developer-only apps in the nav."
            checked={developerMode}
            onCheckedChange={(checked) => setDeveloperMode(checked)}
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
            control={
              <Button
                ref={resetOpenRef}
                variant="destructive"
                size="sm"
                className="rounded-sm whitespace-nowrap"
                aria-haspopup="dialog"
                onClick={() => setResetConfirmOpen(true)}
                {...resetOpenAgentProps}
              >
                {t("settings.resetEverything")}
              </Button>
            }
          />
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
            <DialogTitle>{t("settings.exportAgent")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="settings-export-password"
                className="text-txt-strong"
              >
                {t("settingsview.Password")}
              </Label>
              <Input
                ref={exportPasswordRef}
                id="settings-export-password"
                type="password"
                value={exportPassword}
                onChange={(e) => setState("exportPassword", e.target.value)}
                placeholder={t("settingsview.EnterExportPasswor")}
                className="h-11 rounded-sm bg-bg"
                {...exportPasswordAgentProps}
              />
              <Label className="flex items-center gap-2 font-normal text-muted">
                <Checkbox
                  ref={exportIncludeLogsRef}
                  checked={exportIncludeLogs}
                  onCheckedChange={(checked: boolean | "indeterminate") =>
                    setState("exportIncludeLogs", !!checked)
                  }
                  aria-current={exportIncludeLogs ? "true" : undefined}
                  {...exportIncludeLogsAgentProps}
                />

                {t("settingsview.IncludeRecentLogs")}
              </Label>
            </div>

            {exportError && (
              <div
                className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                role="alert"
                aria-live="assertive"
              >
                {exportError}
              </div>
            )}
            {exportSuccess && (
              <div
                className="rounded-sm border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
                role="status"
                aria-live="polite"
              >
                {exportSuccess}
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
                disabled={exportBusy}
                onClick={() => void handleAgentExport()}
                {...exportSubmitAgentProps}
              >
                {exportBusy && <Spinner size={16} />}
                {t("common.export")}
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
            <DialogTitle>{t("settings.importAgent")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <input
              ref={importFileInputRef}
              type="file"
              className="hidden"
              accept=".eliza-agent,.agent,application/octet-stream"
              onChange={(e) =>
                setState("importFile", e.target.files?.[0] ?? null)
              }
            />

            <div className="space-y-2">
              <div className="text-sm font-medium text-txt-strong">
                {t("settingsview.BackupFile")}
              </div>
              <Button
                ref={importBrowseRef}
                variant="outline"
                className="min-h-[2.625rem] px-4 rounded-sm flex w-full items-center justify-between gap-3 text-left"
                onClick={() => importFileInputRef.current?.click()}
                {...importBrowseAgentProps}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-txt">
                  {importFile?.name ?? t("settingsview.ChooseAnExportedBack")}
                </span>
                <span className="shrink-0 text-xs font-medium text-txt">
                  {importFile
                    ? t("settings.change", { defaultValue: "Change" })
                    : t("settings.browse", { defaultValue: "Browse" })}
                </span>
              </Button>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="settings-import-password"
                className="text-txt-strong"
              >
                {t("settingsview.Password")}
              </Label>
              <Input
                ref={importPasswordRef}
                id="settings-import-password"
                type="password"
                value={importPassword}
                onChange={(e) => setState("importPassword", e.target.value)}
                placeholder={t("settingsview.EnterImportPasswor")}
                className="h-11 rounded-sm bg-bg"
                {...importPasswordAgentProps}
              />
            </div>

            {importError && (
              <div
                className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                role="alert"
                aria-live="assertive"
              >
                {importError}
              </div>
            )}
            {importSuccess && (
              <div
                className="rounded-sm border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
                role="status"
                aria-live="polite"
              >
                {importSuccess}
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
                disabled={importBusy}
                onClick={() => void handleAgentImport()}
                {...importSubmitAgentProps}
              >
                {importBusy && <Spinner size={16} />}
                {t("settings.import")}
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
