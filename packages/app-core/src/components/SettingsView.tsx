/**
 * Settings view — two-panel layout with section navigator and active section.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  SectionCard,
} from "@elizaos/ui";
import {
  AlertTriangle,
  Bot,
  Cloud,
  Download,
  Image,
  Loader2,
  Mic,
  RefreshCw,
  Search,
  Shield,
  Sliders,
  Terminal,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import { CodingAgentSettingsSection } from "./CodingAgentSettingsSection";
import { ConfigPageView } from "./ConfigPageView";
import { CloudDashboard } from "./ElizaCloudDashboard";
import { MediaSettingsSection } from "./MediaSettingsSection";
import { PermissionsSection } from "./PermissionsSection";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { VoiceConfigView } from "./VoiceConfigView";

interface SettingsSectionDef {
  id: string;
  label: string;
  icon: React.ElementType;
  description?: string;
}

const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "ai-model",
    label: "settings.sections.aimodel.label",
    icon: Bot,
    description: "settings.sections.aimodel.desc",
  },
  {
    id: "cloud",
    label: "elizaclouddashboard.ElizaCloud",
    icon: Cloud,
    description: "settings.sections.cloud.desc",
  },
  {
    id: "coding-agents",
    label: "settings.sections.codingagents.label",
    icon: Terminal,
    description: "settings.sections.codingagents.desc",
  },
  {
    id: "wallet-rpc",
    label: "settings.sections.walletrpc.label",
    icon: Wallet,
    description: "settings.sections.walletrpc.desc",
  },
  {
    id: "media",
    label: "settings.sections.media.label",
    icon: Image,
    description: "settings.sections.media.desc",
  },
  {
    id: "voice",
    label: "settings.sections.voice.label",
    icon: Mic,
    description: "settings.sections.voice.desc",
  },
  {
    id: "permissions",
    label: "settings.sections.permissions.label",
    icon: Shield,
    description: "settings.sections.permissions.desc",
  },
  {
    id: "updates",
    label: "settings.sections.updates.label",
    icon: RefreshCw,
    description: "settings.sections.updates.desc",
  },
  {
    id: "advanced",
    label: "nav.advanced",
    icon: Sliders,
    description: "settings.sections.advanced.desc",
  },
];

function matchesSettingsSection(
  section: SettingsSectionDef,
  query: string,
  t: (key: string) => string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    t(section.label).toLowerCase().includes(normalized) ||
    (section.description
      ? t(section.description).toLowerCase().includes(normalized)
      : false)
  );
}

/* ── Settings Sidebar ────────────────────────────────────────────────── */

function SettingsSidebar({
  sections,
  activeSection,
  onSectionChange,
}: {
  sections: SettingsSectionDef[];
  activeSection: string;
  onSectionChange: (id: string) => void;
}) {
  const { t } = useApp();

  return (
    <aside className="hidden w-80 shrink-0 self-start border-r border-border/50 bg-bg/35 backdrop-blur-xl xl:sticky xl:top-0 xl:flex">
      <div className="flex flex-1 flex-col p-5">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted/80">
          {t("settingsview.JumpToSection")}
        </div>

        <nav className="flex flex-col gap-2 pr-1">
          {sections.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => onSectionChange(section.id)}
                aria-current={isActive ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all duration-200 ${
                  isActive
                    ? "border-accent/40 bg-accent/12 text-txt shadow-[0_10px_30px_rgba(var(--accent),0.08)]"
                    : "border-transparent text-muted hover:border-border/60 hover:bg-card/55 hover:text-txt"
                }`}
              >
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border p-2 ${
                    isActive
                      ? "border-accent/30 bg-accent/18 text-txt-strong"
                      : "border-border/50 bg-bg-accent/80 text-muted"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold leading-snug text-current">
                    {t(section.label)}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

/* ── Updates Section ─────────────────────────────────────────────────── */

function UpdatesSection() {
  const { t } = useApp();
  const { updateStatus, updateLoading, loadUpdateStatus } = useApp();

  useEffect(() => {
    void loadUpdateStatus();
  }, [loadUpdateStatus]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-5 bg-card/60 backdrop-blur-sm border border-border/50 rounded-2xl shadow-sm">
        <div>
          <div className="font-medium text-sm">
            {t("settings.versionPrefix")}
          </div>
          <div className="text-2xl font-bold text-txt-strong mt-1">
            {updateStatus?.currentVersion || `${t("common.loading")}...`}
          </div>
        </div>
        <Button
          variant="default"
          size="sm"
          className="rounded-xl shadow-sm whitespace-normal text-left"
          onClick={() => void loadUpdateStatus(true)}
          disabled={updateLoading}
        >
          {updateLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          {updateLoading ? t("settings.checking") : t("settings.checkNow")}
        </Button>
      </div>

      {updateStatus?.updateAvailable && (
        <div className="p-4 bg-ok/10 border border-ok/30 rounded-2xl">
          <div className="font-bold text-ok mb-1">
            {t("settings.updateAvailable")}
          </div>
          <p className="text-sm text-txt-strong">
            {updateStatus.currentVersion} {t("ui-renderer.Rarr")}{" "}
            {updateStatus.latestVersion}
          </p>
        </div>
      )}

      {updateStatus?.lastCheckAt && (
        <div className="text-[11px] text-muted">
          {t("settings.lastChecked")}{" "}
          {new Date(updateStatus.lastCheckAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

/* ── Advanced Section ─────────────────────────────────────────────────── */

function AdvancedSection() {
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
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
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

  return (
    <>
      <div className="space-y-6">
        {/* Export/Import */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={openExportModal}
            className="settings-card-button flex items-center gap-4 border border-border/50 bg-card/60 text-left backdrop-blur-md transition-all group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent),0.1)]"
            aria-haspopup="dialog"
          >
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg-accent p-3 shadow-sm transition-all group-hover:border-accent group-hover:bg-accent">
              <Download className="h-5 w-5 shrink-0 text-txt transition-colors group-hover:text-accent-fg" />
            </div>
            <div>
              <div className="font-medium text-sm">
                {t("settings.exportAgent")}
              </div>
              <div className="text-xs text-muted">
                {t("settings.exportAgentShort")}
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={openImportModal}
            className="settings-card-button flex items-center gap-4 border border-border/50 bg-card/60 text-left backdrop-blur-md transition-all group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent),0.1)]"
            aria-haspopup="dialog"
          >
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg-accent p-3 shadow-sm transition-all group-hover:border-accent group-hover:bg-accent">
              <Upload className="h-5 w-5 shrink-0 text-txt transition-colors group-hover:text-accent-fg" />
            </div>
            <div>
              <div className="font-medium text-sm">
                {t("settings.importAgent")}
              </div>
              <div className="text-xs text-muted">
                {t("settings.importAgentShort")}
              </div>
            </div>
          </button>
        </div>

        {/* Danger Zone */}
        <div className="border border-danger/30 rounded-2xl overflow-hidden bg-bg/40 backdrop-blur-sm">
          <div className="bg-danger/10 px-5 py-3 border-b border-danger/20 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-danger" />
            <span className="font-bold text-sm text-danger tracking-wide uppercase">
              {t("settings.dangerZone")}
            </span>
          </div>
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">
                  {t("settings.resetAgent")}
                </div>
                <div className="text-xs text-muted">
                  {t("settings.resetAgentHint")}
                </div>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="rounded-xl shadow-sm whitespace-normal text-left"
                onClick={() => {
                  void handleReset();
                }}
              >
                {t("settings.resetEverything")}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={exportModalOpen}
        onOpenChange={(open) => {
          if (!open) closeExportModal();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.exportAgent")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="settings-export-password"
                className="text-sm font-medium text-txt-strong"
              >
                {t("settingsview.Password")}
              </label>
              <Input
                id="settings-export-password"
                type="password"
                value={exportPassword}
                onChange={(e) => setState("exportPassword", e.target.value)}
                placeholder={t("settingsview.EnterExportPasswor")}
                className="rounded-lg bg-bg"
              />
              <label className="flex items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={exportIncludeLogs}
                  onChange={(e) =>
                    setState("exportIncludeLogs", e.target.checked)
                  }
                />

                {t("settingsview.IncludeRecentLogs")}
              </label>
            </div>

            {exportError && (
              <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {exportError}
              </div>
            )}
            {exportSuccess && (
              <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">
                {exportSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="settings-button rounded-lg"
                onClick={closeExportModal}
              >
                {t("onboarding.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                className="settings-button rounded-lg"
                disabled={exportBusy}
                onClick={() => void handleAgentExport()}
              >
                {exportBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {t("settings.export")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={importModalOpen}
        onOpenChange={(open) => {
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
              <button
                type="button"
                className="settings-button flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-bg text-left transition-colors hover:bg-bg-hover"
                onClick={() => importFileInputRef.current?.click()}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-txt">
                  {importFile?.name ?? t("settingsview.ChooseAnExportedBack")}
                </span>
                <span className="shrink-0 text-xs font-medium text-txt">
                  {importFile
                    ? t("settings.change", { defaultValue: "Change" })
                    : t("settings.browse", { defaultValue: "Browse" })}
                </span>
              </button>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="settings-import-password"
                className="text-sm font-medium text-txt-strong"
              >
                {t("settingsview.Password")}
              </label>
              <Input
                id="settings-import-password"
                type="password"
                value={importPassword}
                onChange={(e) => setState("importPassword", e.target.value)}
                placeholder={t("settingsview.EnterImportPasswor")}
                className="rounded-lg bg-bg"
              />
            </div>

            {importError && (
              <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {importError}
              </div>
            )}
            {importSuccess && (
              <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">
                {importSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="settings-button rounded-lg"
                onClick={closeImportModal}
              >
                {t("onboarding.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                className="settings-button rounded-lg"
                disabled={importBusy}
                onClick={() => void handleAgentImport()}
              >
                {importBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {t("settings.import")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── SettingsView ─────────────────────────────────────────────────────── */

export function SettingsView({
  inModal,
  onClose,
  initialSection,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
} = {}) {
  const { t, loadPlugins, setTab } = useApp();
  const [activeSection, setActiveSection] = useState(
    initialSection ?? "ai-model",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);

  const visibleSections = useMemo(
    () =>
      SETTINGS_SECTIONS.filter((section) =>
        matchesSettingsSection(section, searchQuery, t),
      ),
    [searchQuery, t],
  );
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
    [visibleSections],
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    scrollContainerRef.current = inModal
      ? shell
      : (shell.closest('[data-shell-scroll-region="true"]') ?? shell);
  }, [inModal]);

  const handleClose = useCallback(
    () => onClose?.() ?? setTab(inModal ? "companion" : "chat"),
    [inModal, onClose, setTab],
  );

  const handleSectionChange = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    if (shellRef.current) {
      const element = shellRef.current.querySelector(`#${sectionId}`);
      if (element instanceof HTMLElement) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, []);

  useEffect(() => {
    if (visibleSections.length === 0) return;
    if (!visibleSectionIds.has(activeSection)) {
      setActiveSection(visibleSections[0].id);
    }
  }, [activeSection, visibleSectionIds, visibleSections]);

  useEffect(() => {
    if (!initialSection) return;
    handleSectionChange(initialSection);
  }, [handleSectionChange, initialSection]);

  useEffect(() => {
    const shell = shellRef.current;
    const root = scrollContainerRef.current;
    if (!shell || !root) return;

    const handleScroll = () => {
      const sections = visibleSections
        .map((section) => {
          const el = shell.querySelector(`#${section.id}`);
          return { id: section.id, el };
        })
        .filter(
          (section): section is { id: string; el: HTMLElement } =>
            section.el instanceof HTMLElement,
        );

      if (sections.length === 0) return;

      if (
        root.scrollHeight - Math.ceil(root.scrollTop) <=
        root.clientHeight + 10
      ) {
        setActiveSection(sections[sections.length - 1].id);
        return;
      }

      const rootRect = root.getBoundingClientRect();
      let currentSection = sections[0].id;

      for (const { id, el } of sections) {
        const elRect = el.getBoundingClientRect();
        if (elRect.top - rootRect.top <= 150) {
          currentSection = id;
        }
      }

      setActiveSection((prev) =>
        prev !== currentSection ? currentSection : prev,
      );
    };

    root.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => root.removeEventListener("scroll", handleScroll);
  }, [visibleSections]);

  const sectionsContent = (
    <>
      {visibleSectionIds.has("ai-model") && (
        <SectionCard
          id="ai-model"
          title={t("settings.aiModel")}
          description={t("settings.aiModelDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <ProviderSwitcher />
        </SectionCard>
      )}

      {visibleSectionIds.has("coding-agents") && (
        <SectionCard
          id="coding-agents"
          title={t("settings.codingAgents")}
          description={t("settings.codingAgentsDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <CodingAgentSettingsSection />
        </SectionCard>
      )}

      {visibleSectionIds.has("cloud") && (
        <section
          id="cloud"
          className="bg-bg rounded-2xl border border-border/50 overflow-hidden relative"
        >
          <CloudDashboard />
        </section>
      )}

      {visibleSectionIds.has("wallet-rpc") && (
        <SectionCard
          id="wallet-rpc"
          title={t("settings.walletRpc")}
          description={t("settings.walletRpcDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <ConfigPageView embedded />
        </SectionCard>
      )}

      {visibleSectionIds.has("media") && (
        <SectionCard
          id="media"
          title={t("settings.mediaGeneration")}
          description={t("settings.mediaDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <MediaSettingsSection />
        </SectionCard>
      )}

      {visibleSectionIds.has("voice") && (
        <SectionCard
          id="voice"
          title={t("settings.speechInterface")}
          description={t("settings.speechDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <VoiceConfigView />
        </SectionCard>
      )}

      {visibleSectionIds.has("permissions") && (
        <SectionCard
          id="permissions"
          title={t("settings.permissionsCapabilities")}
          description={t("settings.permissionsDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <PermissionsSection />
        </SectionCard>
      )}

      {visibleSectionIds.has("updates") && (
        <SectionCard
          id="updates"
          title={t("settings.softwareUpdates")}
          description={t("settings.updatesDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <UpdatesSection />
        </SectionCard>
      )}

      {visibleSectionIds.has("advanced") && (
        <SectionCard
          id="advanced"
          title={t("settings.advancedSettings")}
          description={t("settings.advancedDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <AdvancedSection />
        </SectionCard>
      )}

      {visibleSections.length === 0 && (
        <SectionCard
          id="settings-empty"
          title={t("settingsview.NoMatchingSettings")}
          description={t("settings.noMatchingSettingsDescription")}
          className="p-4 sm:p-5 lg:p-6"
        >
          <button
            type="button"
            className="settings-button inline-flex items-center rounded-lg border border-border text-sm font-medium text-txt transition-colors hover:bg-bg-hover"
            onClick={() => setSearchQuery("")}
          >
            {t("settingsview.ClearSearch")}
          </button>
        </SectionCard>
      )}
    </>
  );

  return (
    <div
      ref={shellRef}
      className={`settings-shell flex min-h-full min-w-0 w-full flex-row items-start ${inModal ? "h-full min-h-0 overflow-y-auto bg-transparent" : "bg-bg"}`}
    >
      <SettingsSidebar
        sections={visibleSections}
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
      />

      <div
        className={`settings-page-content flex-1 min-w-0 scroll-smooth ${inModal ? "px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6" : "px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8"}`}
      >
        <div className="mx-auto max-w-5xl">
          <div className="sticky top-0 z-20 mb-5 rounded-[1.35rem] border border-border/50 bg-bg/80 px-3 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.2)] backdrop-blur-xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border border-border/60 bg-card/70 px-3 focus-within:ring-2 focus-within:ring-accent/40 focus-within:border-accent/50">
                <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <Input
                  type="text"
                  placeholder={t("settings.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 min-w-0 flex-1 border-0 bg-transparent py-0 pr-0 pl-0 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </div>
              <button
                type="button"
                className="settings-icon-button inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition-all hover:border-accent hover:text-txt hover:shadow-sm"
                onClick={handleClose}
                aria-label="Close settings"
                title={t("settingsview.CloseSettings")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="space-y-6 pb-20 pt-1 sm:space-y-8 sm:pt-2">
            {sectionsContent}
          </div>
        </div>
      </div>
    </div>
  );
}
