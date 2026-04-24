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
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
  Spinner,
  useLinkedSidebarSelection,
} from "@elizaos/ui";
import {
  AlertTriangle,
  Archive,
  Brain,
  Cloud,
  Cpu,
  Download,
  Image,
  type LucideIcon,
  Palette,
  Puzzle,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Terminal,
  Upload,
  User,
  Wallet,
} from "lucide-react";
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
import { LocalInferencePanel } from "../local-inference/LocalInferencePanel";
import { AppearanceSettingsSection } from "../settings/AppearanceSettingsSection";
import { CapabilitiesSection } from "../settings/CapabilitiesSection";
import { FeatureTogglesSection } from "../settings/FeatureTogglesSection";
import { MediaSettingsSection } from "../settings/MediaSettingsSection";
import { PermissionsSection } from "../settings/PermissionsSection";
import { ProviderSwitcher } from "../settings/ProviderSwitcher";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ConfigPageView } from "./ConfigPageView";
import { CloudDashboard } from "./ElizaCloudDashboard";
import { ReleaseCenterView } from "./ReleaseCenterView";
import { IdentitySettingsSection } from "./settings/IdentitySettingsSection";

const SETTINGS_SIDEBAR_WIDTH_KEY = "milady:settings:sidebar:width";
const SETTINGS_SIDEBAR_COLLAPSED_KEY = "milady:settings:sidebar:collapsed";
const SETTINGS_SIDEBAR_DEFAULT_WIDTH = 240;
const SETTINGS_SIDEBAR_MIN_WIDTH = 200;
const SETTINGS_SIDEBAR_MAX_WIDTH = 520;

interface SettingsSectionDef {
  id: string;
  label: string;
  defaultLabel: string;
  icon: LucideIcon;
  description?: string;
  defaultDescription?: string;
  keywords?: string[];
  keywordKeys?: string[];
}

function clampSettingsSidebarWidth(value: number): number {
  return Math.min(
    Math.max(value, SETTINGS_SIDEBAR_MIN_WIDTH),
    SETTINGS_SIDEBAR_MAX_WIDTH,
  );
}

function readStoredSettingsSidebarWidth(): number {
  if (typeof window === "undefined") return SETTINGS_SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SETTINGS_SIDEBAR_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return clampSettingsSidebarWidth(parsed);
    }
  } catch {
    /* ignore sandboxed storage */
  }
  return SETTINGS_SIDEBAR_DEFAULT_WIDTH;
}

function readStoredSettingsSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(SETTINGS_SIDEBAR_COLLAPSED_KEY) === "true"
    );
  } catch {
    return false;
  }
}

const SETTINGS_CONTENT_CLASS =
  "[scroll-padding-top:7rem] [scrollbar-gutter:stable] scroll-smooth bg-bg/10 pb-4 pt-2 sm:pb-6 sm:pt-3";
const SETTINGS_CONTENT_WIDTH_CLASS = "w-full min-h-0";
const SETTINGS_SECTION_STACK_CLASS = "space-y-3 pb-10 sm:space-y-4";

const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "identity",
    label: "settings.sections.identity.label",
    defaultLabel: "Basics",
    icon: User,
    description: "settings.sections.identity.desc",
    defaultDescription: "Name, voice, and system prompt.",
    keywords: [
      "identity",
      "name",
      "voice",
      "system prompt",
      "persona",
      "instructions",
      "agent",
    ],
    keywordKeys: ["settings.keyword.voice"],
  },
  {
    id: "cloud",
    label: "providerswitcher.elizaCloud",
    defaultLabel: "Cloud",
    icon: Cloud,
    description: "settings.sections.cloud.desc",
    defaultDescription: "Account, credits, and cloud services.",
    keywords: ["cloud", "billing", "credits", "auth", "subscription"],
    keywordKeys: ["settings.keyword.cloud", "settings.keyword.billing"],
  },
  {
    id: "ai-model",
    label: "settings.sections.aimodel.label",
    defaultLabel: "AI Models",
    icon: Brain,
    description: "settings.sections.aimodel.desc",
    defaultDescription: "Cloud, local, and direct-provider routing.",
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
  },
  {
    id: "local-models",
    label: "settings.sections.localModels.label",
    defaultLabel: "Local Models",
    icon: Cpu,
    description: "settings.sections.localModels.desc",
    defaultDescription: "Download and assign local models.",
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
  },
  {
    id: "coding-agents",
    label: "settings.sections.codingagents.label",
    defaultLabel: "Task Agents",
    icon: Terminal,
    description: "settings.codingAgentsDescription",
    defaultDescription: "Claude Code, Codex, Gemini, and Aider.",
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
  },
  {
    id: "media",
    label: "settings.sections.media.label",
    defaultLabel: "Media",
    icon: Image,
    description: "settings.sections.media.desc",
    defaultDescription: "Image, video, audio, vision, and voice.",
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
  },
  {
    id: "appearance",
    label: "settings.sections.appearance.label",
    defaultLabel: "Appearance",
    icon: Palette,
    description: "settings.sections.appearance.desc",
    defaultDescription: "Language, theme, and content packs.",
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
  },
  {
    id: "capabilities",
    label: "settings.sections.capabilities.label",
    defaultLabel: "Capabilities",
    icon: SlidersHorizontal,
    description: "settings.sections.capabilities.desc",
    defaultDescription: "Agent features and automation surfaces.",
    keywords: [
      "capabilities",
      "wallet",
      "browser",
      "computer use",
      "desktop automation",
      "screenshots",
      "training",
      "auto-training",
      "enable",
      "disable",
      "feature",
    ],
    keywordKeys: [
      "settings.keyword.wallet",
      "settings.keyword.browser",
      "settings.keyword.training",
    ],
  },
  {
    id: "wallet-rpc",
    label: "settings.sections.walletrpc.label",
    defaultLabel: "Wallet & RPC",
    icon: Wallet,
    description: "settings.sections.walletrpc.desc",
    defaultDescription: "Wallet network and RPC providers.",
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
    defaultLabel: "Features",
    icon: Puzzle,
    description: "settings.sections.features.desc",
    defaultDescription: "LifeOps opt-ins.",
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
    defaultLabel: "Permissions",
    icon: Shield,
    description: "settings.sections.permissions.desc",
    defaultDescription: "Browser and device access.",
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
  },
  {
    id: "updates",
    label: "settings.sections.updates.label",
    defaultLabel: "Updates",
    icon: RefreshCw,
    description: "settings.sections.updates.desc",
    defaultDescription: "Software updates.",
    keywords: ["updates", "release", "version", "download"],
    keywordKeys: ["settings.keyword.updates"],
  },
  {
    id: "advanced",
    label: "settings.sections.backupReset.label",
    defaultLabel: "Backup & Reset",
    icon: Archive,
    description: "settings.sections.backupReset.desc",
    defaultDescription: "Export, import, and reset.",
    keywords: [
      "advanced",
      "export",
      "import",
      "reset",
      "debug",
      "backup",
      "restore",
      "danger zone",
      "wipe",
      "start over",
    ],
    keywordKeys: [
      "settings.keyword.advanced",
      "settings.keyword.export",
      "settings.keyword.import",
      "settings.keyword.reset",
    ],
  },
];

function matchesSettingsSection(
  section: SettingsSectionDef,
  query: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const label = t(section.label, { defaultValue: section.defaultLabel });
  const description = section.description
    ? t(section.description, { defaultValue: section.defaultDescription })
    : "";
  return (
    label.toLowerCase().includes(normalized) ||
    description.toLowerCase().includes(normalized) ||
    (section.keywords ?? []).some((keyword) =>
      keyword.toLowerCase().includes(normalized),
    ) ||
    (section.keywordKeys ?? []).some((key) =>
      t(key).toLowerCase().includes(normalized),
    )
  );
}

function settingsSectionLabel(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(section.label, { defaultValue: section.defaultLabel });
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
  showDescription?: boolean;
  bodyClassName?: string;
}

const SettingsSection = forwardRef<HTMLElement, SettingsSectionProps>(
  function SettingsSection(
    {
      title,
      description,
      showDescription = false,
      bodyClassName,
      className,
      children,
      ...props
    },
    ref,
  ) {
    const panelDescription = showDescription ? description : undefined;
    if (title || description) {
      return (
        <PagePanel.CollapsibleSection
          ref={ref}
          as="section"
          expanded
          variant="section"
          heading={title ?? ""}
          headingClassName="text-base sm:text-lg font-semibold tracking-tight text-txt-strong"
          description={panelDescription}
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
    () => initialSection ?? readSettingsHashSection() ?? "identity",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    readStoredSettingsSidebarCollapsed,
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    readStoredSettingsSidebarWidth,
  );
  const shellRef = useRef<HTMLDivElement>(null);

  const handleSidebarCollapsedChange = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem(SETTINGS_SIDEBAR_COLLAPSED_KEY, String(next));
    } catch {
      /* ignore sandboxed storage */
    }
  }, []);

  const handleSidebarWidthChange = useCallback((next: number) => {
    const clamped = clampSettingsSidebarWidth(next);
    setSidebarWidth(clamped);
    try {
      window.localStorage.setItem(SETTINGS_SIDEBAR_WIDTH_KEY, String(clamped));
    } catch {
      /* ignore sandboxed storage */
    }
  }, []);

  const visibleSections = useMemo(() => {
    return SETTINGS_SECTIONS.filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      if (!matchesSettingsSection(section, searchQuery, t)) return false;
      return true;
    });
  }, [searchQuery, t, walletEnabled]);
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

  const activeSectionDef =
    visibleSections.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    visibleSections[0] ??
    null;
  const searchLabel = t("settingsview.SearchSettings", {
    defaultValue: "Search settings",
  });

  const settingsSidebar = (
    <AppPageSidebar
      testId="settings-sidebar"
      collapsible
      collapsed={sidebarCollapsed}
      onCollapsedChange={handleSidebarCollapsedChange}
      resizable
      width={sidebarWidth}
      onWidthChange={handleSidebarWidthChange}
      minWidth={SETTINGS_SIDEBAR_MIN_WIDTH}
      maxWidth={SETTINGS_SIDEBAR_MAX_WIDTH}
      onCollapseRequest={() => handleSidebarCollapsedChange(true)}
      contentIdentity="settings"
      collapseButtonTestId="settings-sidebar-collapse-toggle"
      expandButtonTestId="settings-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse settings"
      expandButtonAriaLabel="Expand settings"
      mobileTitle={t("nav.settings")}
      mobileMeta={
        activeSectionDef ? settingsSectionLabel(activeSectionDef, t) : undefined
      }
      header={
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
      }
    >
      <SidebarScrollRegion className="pt-0">
        <SidebarPanel>
          {visibleSections.length === 0 ? (
            <SidebarContent.EmptyState className="px-4 py-6">
              {t("settingsview.NoMatchingSettings")}
            </SidebarContent.EmptyState>
          ) : (
            <nav className="space-y-1.5" aria-label={t("nav.settings")}>
              {visibleSections.map((section) => {
                const isActive = activeSection === section.id;
                const Icon = section.icon;
                return (
                  <SidebarContent.Item
                    key={section.id}
                    as="div"
                    active={isActive}
                    className="gap-2 py-2"
                    ref={registerSidebarItem(section.id)}
                  >
                    <SidebarContent.ItemButton
                      onClick={() => handleSectionChange(section.id)}
                      aria-current={isActive ? "page" : undefined}
                      className="items-center gap-2.5"
                    >
                      <SidebarContent.ItemIcon
                        active={isActive}
                        className="mt-0 h-8 w-8 rounded-lg p-1.5"
                      >
                        <Icon className="h-4 w-4" aria-hidden />
                      </SidebarContent.ItemIcon>
                      <SidebarContent.ItemBody>
                        <SidebarContent.ItemTitle
                          className={cn(
                            "text-sm leading-5",
                            isActive ? "font-semibold" : "font-medium",
                          )}
                        >
                          {settingsSectionLabel(section, t)}
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
    </AppPageSidebar>
  );

  const sectionsContent = (
    <>
      {visibleSectionIds.has("identity") && (
        <SettingsSection
          id="identity"
          title={t("settings.sections.identity.label", {
            defaultValue: "Basics",
          })}
          description={t("settings.sections.identity.desc", {
            defaultValue: "Name, voice, and system prompt.",
          })}
          ref={registerContentItem("identity")}
        >
          <IdentitySettingsSection />
        </SettingsSection>
      )}

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

      {visibleSectionIds.has("ai-model") && (
        <SettingsSection
          id="ai-model"
          title={t("settings.sections.aimodel.label", {
            defaultValue: "AI Models",
          })}
          description={t("settings.sections.aimodel.desc", {
            defaultValue: "Cloud, local, and direct-provider routing.",
          })}
          ref={registerContentItem("ai-model")}
        >
          <ProviderSwitcher />
        </SettingsSection>
      )}

      {visibleSectionIds.has("local-models") && (
        <SettingsSection
          id="local-models"
          title={t("settings.sections.localModels.label", {
            defaultValue: "Local Models",
          })}
          description={t("settings.sections.localModels.desc", {
            defaultValue: "Download and assign local models.",
          })}
          ref={registerContentItem("local-models")}
        >
          <LocalInferencePanel />
        </SettingsSection>
      )}

      {visibleSectionIds.has("coding-agents") && (
        <SettingsSection
          id="coding-agents"
          title={t("settings.sections.codingagents.label", {
            defaultValue: "Task Agents",
          })}
          description={t("settings.codingAgentsDescription", {
            defaultValue: "Claude Code, Codex, Gemini, and Aider.",
          })}
          ref={registerContentItem("coding-agents")}
        >
          <CodingAgentSettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("media") && (
        <SettingsSection
          id="media"
          title={t("settings.sections.media.label", {
            defaultValue: "Media",
          })}
          description={t("settings.sections.media.desc", {
            defaultValue: "Image, video, audio, vision, and voice.",
          })}
          ref={registerContentItem("media")}
        >
          <MediaSettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("appearance") && (
        <SettingsSection
          id="appearance"
          title={t("settings.sections.appearance.label", {
            defaultValue: "Appearance",
          })}
          description={t("settings.sections.appearance.desc", {
            defaultValue: "Language, theme, and content packs.",
          })}
          ref={registerContentItem("appearance")}
        >
          <AppearanceSettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("capabilities") && (
        <SettingsSection
          id="capabilities"
          title={t("settings.sections.capabilities.label", {
            defaultValue: "Capabilities",
          })}
          description={t("settings.sections.capabilities.desc", {
            defaultValue: "Agent features and automation surfaces.",
          })}
          ref={registerContentItem("capabilities")}
        >
          <CapabilitiesSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("permissions") && (
        <SettingsSection
          id="permissions"
          title={t("settings.sections.permissions.label", {
            defaultValue: "Permissions",
          })}
          description={t("settings.sections.permissions.desc", {
            defaultValue: "Browser and device access.",
          })}
          ref={registerContentItem("permissions")}
        >
          <PermissionsSection />
        </SettingsSection>
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
          title={t("settings.sections.backupReset.label")}
          description={t("settings.sections.backupReset.desc")}
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
          showDescription
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
      sidebar={settingsSidebar}
      contentRef={contentContainerRef}
      contentClassName={SETTINGS_CONTENT_CLASS}
      contentInnerClassName={SETTINGS_CONTENT_WIDTH_CLASS}
      mobileSidebarLabel={
        activeSectionDef
          ? settingsSectionLabel(activeSectionDef, t)
          : t("nav.settings")
      }
    >
      <div ref={shellRef} className={`w-full ${SETTINGS_SECTION_STACK_CLASS}`}>
        {sectionsContent}
      </div>
    </PageLayout>
  );
}
