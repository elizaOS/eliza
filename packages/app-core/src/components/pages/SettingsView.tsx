import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageLayout,
  PagePanel,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
  Spinner,
  Switch,
  useLinkedSidebarSelection,
} from "@elizaos/ui";
import { AlertTriangle, Download, Upload } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CodingAgentSettingsSection } from "../../app-shell/task-coordinator-slots.js";
import { useApp } from "../../state";
import { WidgetHost } from "../../widgets";
import { LocalInferencePanel } from "../local-inference/LocalInferencePanel";
import { AppearanceSettingsSection } from "../settings/AppearanceSettingsSection";
import { CapabilitiesSection } from "../settings/CapabilitiesSection";
import { FeatureTogglesSection } from "../settings/FeatureTogglesSection";
import { LearnedSkillsPanel } from "../settings/LearnedSkills";
import { MediaSettingsSection } from "../settings/MediaSettingsSection";
import { PermissionsSection } from "../settings/PermissionsSection";
import { ProviderSwitcher } from "../settings/ProviderSwitcher";
import { TrainingSettingsPanel } from "../settings/TrainingSettings";
import { ConfigPageView } from "./ConfigPageView";
import { CloudDashboard } from "./ElizaCloudDashboard";
import { ReleaseCenterView } from "./ReleaseCenterView";

type SettingsComplexity = "simple" | "advanced";

interface SettingsSectionDef {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  keywordKeys?: string[];
  /**
   * Visibility level. "simple" sections show in both Simple and Advanced
   * modes. "advanced" sections only show when the user toggles Advanced.
   * Sections default to "simple" if omitted.
   */
  level?: SettingsComplexity;
}

const SETTINGS_COMPLEXITY_STORAGE_KEY = "milady.settings.complexity";

function readStoredComplexity(): SettingsComplexity {
  if (typeof window === "undefined") return "simple";
  try {
    const raw = window.localStorage.getItem(SETTINGS_COMPLEXITY_STORAGE_KEY);
    return raw === "advanced" ? "advanced" : "simple";
  } catch {
    return "simple";
  }
}

function writeStoredComplexity(value: SettingsComplexity): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_COMPLEXITY_STORAGE_KEY, value);
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

const SETTINGS_CONTENT_CLASS =
  "[scroll-padding-top:7rem] [scrollbar-gutter:stable] scroll-smooth bg-bg/10 pb-4 pt-2 sm:pb-6 sm:pt-3";
const SETTINGS_CONTENT_WIDTH_CLASS = "w-full min-h-0";
const SETTINGS_SECTION_STACK_CLASS = "space-y-3 pb-10 sm:space-y-4";

const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "cloud",
    label: "providerswitcher.elizaCloud",
    description: "settings.sections.cloud.desc",
    keywords: ["cloud", "billing", "credits", "auth", "subscription"],
    keywordKeys: ["settings.keyword.cloud", "settings.keyword.billing"],
    level: "simple",
  },
  {
    // Cloud and direct-provider model routing. Local model runtime controls are
    // split into the advanced Local Models section below.
    id: "ai-model",
    label: "settings.sections.aimodel.label",
    description: "settings.sections.aimodel.desc",
    keywords: [
      "model",
      "provider",
      "openai",
      "anthropic",
      "grok",
      "gemini",
      "api key",
      "inference",
      "llm",
      "local",
      "llama",
      "llama.cpp",
      "gguf",
      "download",
      "offline",
      "gpu",
      "vram",
      "device",
      "phone",
    ],
    keywordKeys: [
      "settings.keyword.model",
      "settings.keyword.provider",
      "settings.keyword.apiKey",
      "settings.keyword.inference",
    ],
    level: "simple",
  },
  {
    id: "local-models",
    label: "settings.sections.localModels.label",
    description: "settings.sections.localModels.desc",
    keywords: [
      "local",
      "llama",
      "llama.cpp",
      "gguf",
      "model",
      "download",
      "inference",
      "offline",
      "gpu",
      "vram",
    ],
    level: "advanced",
  },
  {
    id: "coding-agents",
    label: "settings.sections.codingagents.label",
    description: "settings.codingAgentsDescription",
    keywords: [
      "codex",
      "agent",
      "reasoning",
      "parallel",
      "approval",
      "routing",
      "provider routing",
      "task coordinator",
      "task agents",
    ],
    level: "advanced",
  },
  {
    id: "media",
    label: "settings.sections.media.label",
    description: "settings.sections.media.desc",
    keywords: [
      "audio",
      "voice",
      "video",
      "camera",
      "microphone",
      "speech",
      "tts",
      "avatar",
    ],
    keywordKeys: [
      "settings.keyword.voice",
      "settings.keyword.audio",
      "settings.keyword.camera",
      "settings.keyword.microphone",
    ],
    level: "simple",
  },
  {
    id: "appearance",
    label: "settings.sections.appearance.label",
    description: "settings.sections.appearance.desc",
    keywords: [
      "appearance",
      "theme",
      "content pack",
      "vrm",
      "avatar",
      "background",
      "color scheme",
      "skin",
      "character",
    ],
    keywordKeys: [
      "settings.keyword.theme",
      "settings.keyword.avatar",
      "settings.keyword.appearance",
    ],
    level: "simple",
  },
  {
    id: "capabilities",
    label: "settings.sections.capabilities.label",
    description: "settings.sections.capabilities.desc",
    keywords: [
      "capabilities",
      "wallet",
      "browser",
      "computer use",
      "desktop automation",
      "screenshots",
      "enable",
      "disable",
      "feature",
    ],
    keywordKeys: ["settings.keyword.wallet", "settings.keyword.browser"],
    level: "advanced",
  },
  {
    id: "wallet-rpc",
    label: "settings.sections.walletrpc.label",
    description: "settings.sections.walletrpc.desc",
    keywords: [
      "wallet",
      "rpc",
      "evm",
      "solana",
      "api key",
      "alchemy",
      "quicknode",
      "helius",
      "birdeye",
    ],
    keywordKeys: ["settings.keyword.wallet", "settings.keyword.apiKey"],
  },
  {
    id: "feature-toggles",
    label: "settings.sections.features.label",
    description: "settings.sections.features.desc",
    keywords: [
      "feature",
      "toggle",
      "flight",
      "booking",
      "travel provider",
      "push",
      "notification",
      "browser",
      "automation",
      "opt in",
      "opt out",
    ],
    keywordKeys: ["settings.keyword.features"],
  },
  {
    id: "permissions",
    label: "settings.sections.permissions.label",
    description: "settings.sections.permissions.desc",
    keywords: [
      "permissions",
      "desktop",
      "filesystem",
      "security",
      "microphone permission",
      "camera permission",
      "file access",
    ],
    keywordKeys: ["settings.keyword.permissions", "settings.keyword.security"],
    level: "simple",
  },
  {
    id: "learned-skills",
    label: "settings.sections.learnedSkills.label",
    description: "settings.sections.learnedSkills.desc",
    keywords: [
      "learned",
      "skills",
      "curated",
      "trajectory",
      "training",
      "agent",
      "promote",
      "disable",
    ],
    keywordKeys: ["settings.keyword.skills", "settings.keyword.training"],
  },
  {
    id: "auto-training",
    label: "settings.sections.autoTraining.label",
    description: "settings.sections.autoTraining.desc",
    keywords: [
      "auto",
      "training",
      "auto-train",
      "trigger",
      "threshold",
      "cooldown",
      "vertex",
      "atropos",
      "tinker",
      "native",
      "trajectory",
      "fine-tune",
      "fine tune",
    ],
    keywordKeys: ["settings.keyword.training"],
  },
  {
    id: "updates",
    label: "settings.sections.updates.label",
    description: "settings.sections.updates.desc",
    keywords: ["updates", "release", "version", "download"],
    keywordKeys: ["settings.keyword.updates"],
    level: "advanced",
  },
  {
    id: "advanced",
    label: "nav.advanced",
    description: "settings.sections.advanced.desc",
    keywords: [
      "advanced",
      "export",
      "import",
      "reset",
      "debug",
      "backup",
      "restore",
      "danger zone",
    ],
    keywordKeys: [
      "settings.keyword.advanced",
      "settings.keyword.export",
      "settings.keyword.import",
      "settings.keyword.reset",
    ],
    level: "advanced",
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
      : false) ||
    (section.keywords ?? []).some((keyword) =>
      keyword.toLowerCase().includes(normalized),
    ) ||
    (section.keywordKeys ?? []).some((key) =>
      t(key).toLowerCase().includes(normalized),
    )
  );
}

function readSettingsHashSection(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  return SETTINGS_SECTIONS.some((section) => section.id === hash) ? hash : null;
}

interface SettingsSectionProps extends ComponentPropsWithoutRef<"section"> {
  title?: string;
  description?: string;
  bodyClassName?: string;
}

const SettingsSection = forwardRef<HTMLElement, SettingsSectionProps>(
  function SettingsSection(
    { title, description, bodyClassName, className, children, ...props },
    ref,
  ) {
    if (title || description) {
      return (
        <PagePanel.CollapsibleSection
          ref={ref}
          as="section"
          expanded
          variant="section"
          heading={title ?? ""}
          headingClassName="text-base sm:text-lg font-semibold tracking-tight text-txt-strong"
          description={description}
          descriptionClassName="mt-0.5 text-xs leading-snug text-muted"
          bodyClassName={cn("px-4 pb-3 pt-0 sm:px-5 sm:pb-4", bodyClassName)}
          className={cn("rounded-2xl", className)}
          {...props}
        >
          {children}
        </PagePanel.CollapsibleSection>
      );
    }

    return (
      <section
        ref={ref}
        data-content-align-offset={4}
        className={className}
        {...props}
      >
        <PagePanel variant="section">
          <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
        </PagePanel>
      </section>
    );
  },
);

/* ── Updates Section ─────────────────────────────────────────────────── */

function UpdatesSection() {
  return <ReleaseCenterView />;
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Button
            variant="outline"
            type="button"
            onClick={openExportModal}
            className="min-h-[5.5rem] h-auto rounded-[calc(var(--radius-xl)+2px)] border border-border/50 bg-card/60 p-5 text-left backdrop-blur-md transition-[transform,border-color,background-color,box-shadow] group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent-rgb),0.1)]"
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
          </Button>

          <Button
            variant="outline"
            type="button"
            onClick={openImportModal}
            className="min-h-[5.5rem] h-auto rounded-[calc(var(--radius-xl)+2px)] border border-border/50 bg-card/60 p-5 text-left backdrop-blur-md transition-[transform,border-color,background-color,box-shadow] group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent-rgb),0.1)]"
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
          </Button>
        </div>
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
                className="rounded-xl shadow-sm whitespace-nowrap"
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
                id="settings-export-password"
                type="password"
                value={exportPassword}
                onChange={(e) => setState("exportPassword", e.target.value)}
                placeholder={t("settingsview.EnterExportPasswor")}
                className="rounded-lg bg-bg"
              />
              <Label className="flex items-center gap-2 font-normal text-muted">
                <Checkbox
                  checked={exportIncludeLogs}
                  onCheckedChange={(checked: boolean | "indeterminate") =>
                    setState("exportIncludeLogs", !!checked)
                  }
                />

                {t("settingsview.IncludeRecentLogs")}
              </Label>
            </div>

            {exportError && (
              <div
                className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                role="alert"
                aria-live="assertive"
              >
                {exportError}
              </div>
            )}
            {exportSuccess && (
              <div
                className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
                role="status"
                aria-live="polite"
              >
                {exportSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)+2px)]"
                onClick={closeExportModal}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)+2px)]"
                disabled={exportBusy}
                onClick={() => void handleAgentExport()}
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
                variant="outline"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)+2px)] flex w-full items-center justify-between gap-3 text-left"
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
                id="settings-import-password"
                type="password"
                value={importPassword}
                onChange={(e) => setState("importPassword", e.target.value)}
                placeholder={t("settingsview.EnterImportPasswor")}
                className="rounded-lg bg-bg"
              />
            </div>

            {importError && (
              <div
                className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                role="alert"
                aria-live="assertive"
              >
                {importError}
              </div>
            )}
            {importSuccess && (
              <div
                className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
                role="status"
                aria-live="polite"
              >
                {importSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)+2px)]"
                onClick={closeImportModal}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)+2px)]"
                disabled={importBusy}
                onClick={() => void handleAgentImport()}
              >
                {importBusy && <Spinner size={16} />}
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
  onClose: _onClose,
  initialSection,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
} = {}) {
  const { t, loadPlugins, walletEnabled } = useApp();
  const [activeSection, setActiveSection] = useState(
    () => initialSection ?? readSettingsHashSection() ?? "cloud",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [complexity, setComplexity] = useState<SettingsComplexity>(() =>
    readStoredComplexity(),
  );
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    writeStoredComplexity(complexity);
  }, [complexity]);

  const visibleSections = useMemo(() => {
    const searchActive = searchQuery.trim().length > 0;
    return SETTINGS_SECTIONS.filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      if (!matchesSettingsSection(section, searchQuery, t)) return false;
      if (complexity === "advanced") return true;
      if (searchActive) return true;
      return section.level !== "advanced";
    });
  }, [complexity, searchQuery, t, walletEnabled]);
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
    [visibleSections],
  );
  const {
    contentContainerRef,
    queueContentAlignment,
    registerContentItem,
    registerSidebarItem,
  } = useLinkedSidebarSelection<string>({
    contentTopOffset: 24,
    enabled: visibleSections.length > 0,
    selectedId: visibleSectionIds.has(activeSection) ? activeSection : null,
    topAlignedId: visibleSections[0]?.id ?? null,
  });

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const handleSectionChange = useCallback(
    (sectionId: string) => {
      setActiveSection(sectionId);
      queueContentAlignment(sectionId);
    },
    [queueContentAlignment],
  );

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
    const root = contentContainerRef.current;
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
  }, [contentContainerRef, visibleSections]);

  const searchLabel = t("settingsview.SearchSettings", {
    defaultValue: "Search settings",
  });
  const activeSectionDef =
    visibleSections.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    visibleSections[0] ??
    null;

  const settingsSidebar = (
    <Sidebar
      testId="settings-sidebar"
      collapsible
      contentIdentity="settings"
      collapseButtonTestId="settings-sidebar-collapse-toggle"
      expandButtonTestId="settings-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse settings"
      expandButtonAriaLabel="Expand settings"
      mobileTitle={t("nav.settings")}
      mobileMeta={activeSectionDef ? t(activeSectionDef.label) : undefined}
      header={
        <div className="space-y-2">
          <SidebarHeader
            search={{
              value: searchQuery,
              onChange: (event) => setSearchQuery(event.target.value),
              onClear: () => setSearchQuery(""),
              placeholder: searchLabel,
              "aria-label": searchLabel,
              autoComplete: "off",
              spellCheck: false,
            }}
          />
          <div className="flex items-center justify-between gap-3 px-4 pb-1">
            <Label
              htmlFor="settings-advanced-toggle"
              className="text-xs font-medium text-muted cursor-pointer select-none"
            >
              {t("settings.showAdvanced", {
                defaultValue: "Show advanced",
              })}
            </Label>
            <Switch
              id="settings-advanced-toggle"
              checked={complexity === "advanced"}
              onCheckedChange={(checked) =>
                setComplexity(checked ? "advanced" : "simple")
              }
              aria-label={t("settings.showAdvanced", {
                defaultValue: "Show advanced",
              })}
            />
          </div>
        </div>
      }
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          {visibleSections.length === 0 ? (
            <SidebarContent.EmptyState className="px-4 py-6">
              {t("settingsview.NoMatchingSettings")}
            </SidebarContent.EmptyState>
          ) : (
            <nav className="space-y-1.5" aria-label={t("nav.settings")}>
              {visibleSections.map((section) => {
                const isActive = activeSection === section.id;
                return (
                  <SidebarContent.Item
                    key={section.id}
                    as="div"
                    active={isActive}
                    className="gap-2"
                    ref={registerSidebarItem(section.id)}
                  >
                    <SidebarContent.ItemButton
                      onClick={() => handleSectionChange(section.id)}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <SidebarContent.ItemBody>
                        <SidebarContent.ItemTitle
                          className={isActive ? "font-semibold" : "font-medium"}
                        >
                          {t(section.label)}
                        </SidebarContent.ItemTitle>
                      </SidebarContent.ItemBody>
                    </SidebarContent.ItemButton>
                  </SidebarContent.Item>
                );
              })}
            </nav>
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );

  const sectionsContent = (
    <>
      {visibleSectionIds.has("cloud") && (
        <SettingsSection
          id="cloud"
          className="relative overflow-hidden"
          bodyClassName="p-0"
          ref={registerContentItem("cloud")}
        >
          <CloudDashboard />
        </SettingsSection>
      )}

      {(visibleSectionIds.has("ai-model") ||
        visibleSectionIds.has("media") ||
        visibleSectionIds.has("appearance")) && (
        <div className="grid gap-5 xl:grid-cols-2 items-start">
          <div className="flex flex-col gap-5 min-w-0">
            {visibleSectionIds.has("ai-model") && (
              <SettingsSection
                id="ai-model"
                title={t("settings.sections.aimodel.label")}
                description={t("settings.sections.aimodel.desc")}
                ref={registerContentItem("ai-model")}
              >
                <ProviderSwitcher showAdvanced={complexity === "advanced"} />
              </SettingsSection>
            )}

            {visibleSectionIds.has("appearance") && (
              <SettingsSection
                id="appearance"
                title={t("settings.sections.appearance.label", {
                  defaultValue: "Appearance",
                })}
                description={t("settings.sections.appearance.desc", {
                  defaultValue:
                    "Content packs, VRM avatars, backgrounds, and themes",
                })}
                ref={registerContentItem("appearance")}
              >
                <AppearanceSettingsSection />
              </SettingsSection>
            )}
          </div>

          {visibleSectionIds.has("media") && (
            <SettingsSection
              id="media"
              title={t("settings.sections.media.label")}
              description={t("settings.sections.media.desc")}
              ref={registerContentItem("media")}
            >
              <MediaSettingsSection showAdvanced={complexity === "advanced"} />
            </SettingsSection>
          )}
        </div>
      )}

      {(visibleSectionIds.has("local-models") ||
        visibleSectionIds.has("coding-agents")) && (
        <div className="grid gap-5 xl:grid-cols-2 items-start">
          {visibleSectionIds.has("local-models") && (
            <SettingsSection
              id="local-models"
              title={t("settings.sections.localModels.label", {
                defaultValue: "Local models",
              })}
              description={t("settings.sections.localModels.desc", {
                defaultValue:
                  "Run llama.cpp models on this machine. Browse the curated catalog, download, and switch between local models.",
              })}
              ref={registerContentItem("local-models")}
            >
              <LocalInferencePanel />
            </SettingsSection>
          )}

          {visibleSectionIds.has("coding-agents") && (
            <SettingsSection
              id="coding-agents"
              title={t("settings.sections.codingagents.label")}
              description={t("settings.codingAgentsDescription")}
              ref={registerContentItem("coding-agents")}
            >
              <CodingAgentSettingsSection />
            </SettingsSection>
          )}
        </div>
      )}

      {(visibleSectionIds.has("capabilities") ||
        visibleSectionIds.has("permissions")) && (
        <div className="grid gap-5 xl:grid-cols-2 items-start">
          {visibleSectionIds.has("capabilities") && (
            <SettingsSection
              id="capabilities"
              title={t("settings.sections.capabilities.label", {
                defaultValue: "Capabilities",
              })}
              description={t("settings.sections.capabilities.desc", {
                defaultValue: "Enable or disable agent capabilities",
              })}
              ref={registerContentItem("capabilities")}
            >
              <CapabilitiesSection />
            </SettingsSection>
          )}

          {visibleSectionIds.has("permissions") && (
            <SettingsSection
              id="permissions"
              title={t("settings.sections.permissions.label")}
              description={t("settings.sections.permissions.desc")}
              ref={registerContentItem("permissions")}
            >
              <PermissionsSection />
            </SettingsSection>
          )}
        </div>
      )}

      {visibleSectionIds.has("wallet-rpc") && (
        <SettingsSection
          id="wallet-rpc"
          title={t("settings.sections.walletrpc.label")}
          description={t("settings.sections.walletrpc.desc")}
          bodyClassName="p-4 sm:p-5"
          ref={registerContentItem("wallet-rpc")}
        >
          <ConfigPageView embedded />
        </SettingsSection>
      )}

      {visibleSectionIds.has("feature-toggles") && (
        <SettingsSection
          id="feature-toggles"
          title={t("settings.sections.features.label", {
            defaultValue: "Features",
          })}
          description={t("settings.sections.features.desc", {
            defaultValue:
              "Opt in to LifeOps capabilities like flight booking, push, and browser automation.",
          })}
          ref={registerContentItem("feature-toggles")}
        >
          <FeatureTogglesSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("learned-skills") && (
        <SettingsSection
          id="learned-skills"
          title={t("settings.sections.learnedSkills.label")}
          description={t("settings.sections.learnedSkills.desc")}
          ref={registerContentItem("learned-skills")}
        >
          <LearnedSkillsPanel />
        </SettingsSection>
      )}

      {visibleSectionIds.has("auto-training") && (
        <SettingsSection
          id="auto-training"
          title={t("settings.sections.autoTraining.label", {
            defaultValue: "Auto-training",
          })}
          description={t("settings.sections.autoTraining.desc", {
            defaultValue:
              "Counts completed trajectories per task and fires a training run when the threshold is hit.",
          })}
          ref={registerContentItem("auto-training")}
        >
          <TrainingSettingsPanel />
        </SettingsSection>
      )}

      {visibleSectionIds.has("updates") && (
        <SettingsSection
          id="updates"
          title={t("settings.sections.updates.label")}
          description={t("settings.sections.updates.desc")}
          ref={registerContentItem("updates")}
        >
          <UpdatesSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("advanced") && (
        <SettingsSection
          id="advanced"
          title={t("nav.advanced")}
          description={t("settings.sections.advanced.desc")}
          ref={registerContentItem("advanced")}
        >
          <AdvancedSection />
        </SettingsSection>
      )}

      {visibleSections.length === 0 && (
        <SettingsSection
          id="settings-empty"
          title={t("settingsview.NoMatchingSettings")}
          description={t("settings.noMatchingSettingsDescription")}
        >
          <Button
            variant="outline"
            className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)+2px)]"
            onClick={() => setSearchQuery("")}
          >
            {t("settingsview.ClearSearch")}
          </Button>
        </SettingsSection>
      )}
    </>
  );

  return (
    <PageLayout
      className={cn("h-full", inModal && "min-h-0")}
      data-testid="settings-shell"
      footer={<WidgetHost slot="settings" />}
      footerClassName="pt-2"
      sidebar={settingsSidebar}
      contentRef={contentContainerRef}
      contentClassName={SETTINGS_CONTENT_CLASS}
      contentInnerClassName={SETTINGS_CONTENT_WIDTH_CLASS}
      mobileSidebarLabel={
        activeSectionDef ? t(activeSectionDef.label) : t("nav.settings")
      }
    >
      <div ref={shellRef} className={`w-full ${SETTINGS_SECTION_STACK_CLASS}`}>
        {sectionsContent}
      </div>
    </PageLayout>
  );
}
