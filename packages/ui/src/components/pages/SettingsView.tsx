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
  SidebarPanel,
  SidebarScrollRegion,
  Spinner,
  useLinkedSidebarSelection,
} from "@elizaos/ui";
import {
  AlertTriangle,
  Archive,
  Brain,
  Download,
  KeyRound,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Palette,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
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
import {
  consumePendingFocusProvider,
  SETTINGS_FOCUS_CONNECTOR_EVENT,
  type SettingsFocusConnectorDetail,
  setDeveloperMode,
  useApp,
  useIsDeveloperMode,
} from "../../state";
import { AppearanceSettingsSection } from "../settings/AppearanceSettingsSection";
import { AppPermissionsSection } from "../settings/AppPermissionsSection";
import { AppsManagementSection } from "../settings/AppsManagementSection";
import { CapabilitiesSection } from "../settings/CapabilitiesSection";
import { IdentitySettingsSection } from "../settings/IdentitySettingsSection";
import { PermissionsSection } from "../settings/PermissionsSection";
import { ProviderSwitcher } from "../settings/ProviderSwitcher";
import { RuntimeSettingsSection } from "../settings/RuntimeSettingsSection";
import { SecretsManagerSection } from "../settings/SecretsManagerSection";
import { SecuritySettingsSection } from "../settings/SecuritySettingsSection";
import { WalletKeysSection } from "../settings/WalletKeysSection";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ConfigPageView } from "./ConfigPageView";
import { ReleaseCenterView } from "./ReleaseCenterView";

type SettingsSectionTone = "ok" | "warn" | "muted" | "accent" | "neutral";

interface SettingsSectionDef {
  id: string;
  label: string;
  defaultLabel: string;
  icon: LucideIcon;
  tone: SettingsSectionTone;
  tooltipDescription?: string;
  defaultTooltipDescription?: string;
}

const SETTINGS_CONTENT_CLASS =
  "[scroll-padding-top:7rem] [scrollbar-gutter:stable] scroll-smooth bg-bg/10 pb-4 pt-2 sm:pb-6 sm:pt-3";
const SETTINGS_CONTENT_WIDTH_CLASS = "w-full min-h-0";
const SETTINGS_SECTION_STACK_CLASS = "space-y-3 pb-10 sm:space-y-4";

const SECTION_TONE_ICON_CLASS: Record<SettingsSectionTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  muted: "text-muted",
  accent: "text-accent",
  neutral: "",
};

const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "identity",
    label: "settings.sections.identity.label",
    defaultLabel: "Basics",
    icon: User,
    tone: "neutral",
    tooltipDescription: "settings.sections.identity.desc",
    defaultTooltipDescription: "Name, voice, prompt.",
  },
  {
    id: "ai-model",
    label: "settings.sections.aimodel.label",
    defaultLabel: "Providers",
    icon: Brain,
    tone: "accent",
    tooltipDescription: "settings.sections.aimodel.desc",
    defaultTooltipDescription: "Cloud, local, subscriptions, keys.",
  },
  {
    id: "runtime",
    label: "settings.sections.runtime.label",
    defaultLabel: "Runtime",
    icon: Server,
    tone: "neutral",
    tooltipDescription: "settings.sections.runtime.desc",
    defaultTooltipDescription: "Local, cloud, or remote.",
  },
  {
    id: "appearance",
    label: "settings.sections.appearance.label",
    defaultLabel: "Appearance",
    icon: Palette,
    tone: "neutral",
    tooltipDescription: "settings.sections.appearance.desc",
    defaultTooltipDescription: "Language, theme, packs.",
  },
  {
    id: "capabilities",
    label: "settings.sections.capabilities.label",
    defaultLabel: "Capabilities",
    icon: SlidersHorizontal,
    tone: "accent",
    tooltipDescription: "settings.sections.capabilities.desc",
    defaultTooltipDescription: "Agent features and automations.",
  },
  {
    id: "apps",
    label: "settings.sections.apps.label",
    defaultLabel: "Apps",
    icon: LayoutGrid,
    tone: "accent",
    tooltipDescription: "settings.sections.apps.desc",
    defaultTooltipDescription: "Installed apps and creation.",
  },
  {
    id: "app-permissions",
    label: "settings.sections.apppermissions.label",
    defaultLabel: "App Permissions",
    icon: ShieldCheck,
    tone: "warn",
    tooltipDescription: "settings.sections.apppermissions.desc",
    defaultTooltipDescription: "Per-app filesystem and network grants.",
  },
  {
    id: "wallet-rpc",
    label: "settings.sections.walletrpc.label",
    defaultLabel: "Wallet & RPC",
    icon: Wallet,
    tone: "neutral",
    tooltipDescription: "settings.sections.walletrpc.desc",
    defaultTooltipDescription: "Wallet network and RPC.",
  },
  {
    id: "permissions",
    label: "settings.sections.permissions.label",
    defaultLabel: "Permissions",
    icon: Shield,
    tone: "warn",
    tooltipDescription: "settings.sections.permissions.desc",
    defaultTooltipDescription: "Browser and device access.",
  },
  {
    id: "secrets",
    label: "settings.sections.secrets.label",
    defaultLabel: "Vault",
    icon: KeyRound,
    tone: "warn",
    tooltipDescription: "settings.sections.secrets.desc",
    defaultTooltipDescription: "Secrets, logins, routing.",
  },
  {
    id: "security",
    label: "settings.sections.security.label",
    defaultLabel: "Security",
    icon: Lock,
    tone: "warn",
    tooltipDescription: "settings.sections.security.desc",
    defaultTooltipDescription: "Local and remote access.",
  },
  {
    id: "updates",
    label: "settings.sections.updates.label",
    defaultLabel: "Updates",
    icon: RefreshCw,
    tone: "neutral",
    tooltipDescription: "settings.sections.updates.desc",
    defaultTooltipDescription: "Software updates.",
  },
  {
    id: "advanced",
    label: "settings.sections.backupReset.label",
    defaultLabel: "Backup & Reset",
    icon: Archive,
    tone: "neutral",
    tooltipDescription: "settings.sections.backupReset.desc",
    defaultTooltipDescription: "Export, import, reset.",
  },
];

function settingsSectionLabel(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(section.label, { defaultValue: section.defaultLabel });
}

function settingsSectionTooltip(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string | undefined {
  if (!section.tooltipDescription) return section.defaultTooltipDescription;
  return t(section.tooltipDescription, {
    defaultValue: section.defaultTooltipDescription ?? "",
  });
}

function readSettingsHashSection(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  if (hash === "cloud") return "ai-model";
  return SETTINGS_SECTIONS.some((section) => section.id === hash) ? hash : null;
}

function replaceSettingsHash(sectionId: string): void {
  if (typeof window === "undefined") return;
  const nextHash = `#${sectionId}`;
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, "", nextHash);
}

interface SettingsSectionProps extends ComponentPropsWithoutRef<"section"> {
  title?: string;
  bodyClassName?: string;
}

const SettingsSection = forwardRef<HTMLElement, SettingsSectionProps>(
  function SettingsSection(
    { title, bodyClassName, className, children, ...props },
    ref,
  ) {
    if (title) {
      return (
        <PagePanel.CollapsibleSection
          ref={ref}
          as="section"
          expanded
          variant="section"
          heading={title}
          headingClassName="text-base sm:text-lg font-semibold tracking-tight text-txt-strong"
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
  const developerMode = useIsDeveloperMode();
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
            className="min-h-[5.5rem] h-auto rounded-[calc(var(--radius-xl)_+_2px)] border border-border/50 bg-card/60 p-5 text-left backdrop-blur-md transition-[transform,border-color,background-color,box-shadow] group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent-rgb),0.1)]"
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
            className="min-h-[5.5rem] h-auto rounded-[calc(var(--radius-xl)_+_2px)] border border-border/50 bg-card/60 p-5 text-left backdrop-blur-md transition-[transform,border-color,background-color,box-shadow] group hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_4px_20px_rgba(var(--accent-rgb),0.1)]"
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
        <div className="border border-border/50 rounded-2xl overflow-hidden bg-bg/40 backdrop-blur-sm">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium text-sm">Developer Mode</div>
                <div className="text-xs text-muted">
                  Show developer tools (logs, trajectory viewer, prompt
                  artifacts) and developer-only apps in the nav.
                </div>
              </div>
              <Label className="flex items-center gap-2 font-normal text-muted whitespace-nowrap">
                <Checkbox
                  checked={developerMode}
                  onCheckedChange={(checked: boolean | "indeterminate") =>
                    setDeveloperMode(!!checked)
                  }
                />
                <span>{developerMode ? "Enabled" : "Disabled"}</span>
              </Label>
            </div>
          </div>
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
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]"
                onClick={closeExportModal}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]"
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
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)] flex w-full items-center justify-between gap-3 text-left"
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
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]"
                onClick={closeImportModal}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]"
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
  const shellRef = useRef<HTMLDivElement>(null);
  const initialAlignmentPendingRef = useRef(true);
  const scrollSelectionSuppressionTimerRef = useRef<number | null>(null);

  const suppressScrollSelection = useCallback((durationMs = 700) => {
    if (typeof window === "undefined") return;
    initialAlignmentPendingRef.current = true;
    if (scrollSelectionSuppressionTimerRef.current != null) {
      window.clearTimeout(scrollSelectionSuppressionTimerRef.current);
    }
    scrollSelectionSuppressionTimerRef.current = window.setTimeout(() => {
      initialAlignmentPendingRef.current = false;
      scrollSelectionSuppressionTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (
        typeof window !== "undefined" &&
        scrollSelectionSuppressionTimerRef.current != null
      ) {
        window.clearTimeout(scrollSelectionSuppressionTimerRef.current);
      }
    };
  }, []);

  const visibleSections = useMemo(() => {
    return SETTINGS_SECTIONS.filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      return true;
    });
  }, [walletEnabled]);
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

  const alignContentToSection = useCallback(
    (sectionId: string): boolean => {
      const root = contentContainerRef.current;
      const shell = shellRef.current;
      const target = shell?.querySelector(`#${sectionId}`);
      if (!(root instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        return false;
      }

      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      root.scrollTo({
        top: root.scrollTop + targetRect.top - rootRect.top - 24,
        behavior: "auto",
      });
      return true;
    },
    [contentContainerRef],
  );

  const queueSectionAlignment = useCallback(
    (sectionId: string) => {
      suppressScrollSelection();
      queueContentAlignment(sectionId);
      if (typeof window === "undefined") return;
      window.requestAnimationFrame(() => {
        if (!alignContentToSection(sectionId)) {
          window.setTimeout(() => alignContentToSection(sectionId), 50);
        }
      });
    },
    [alignContentToSection, queueContentAlignment, suppressScrollSelection],
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // Deep-link target: another component (e.g. AutomationsView's missing-creds
  // banner, or apps/app/src/main.tsx parsing eliza://settings/connectors/<x>)
  // dispatches SETTINGS_FOCUS_CONNECTOR_EVENT with the canonical provider id.
  // We focus the Integrations section, then scroll the matching panel wrapper
  // (`[data-connector="<provider>"]`) into view and briefly flash it.
  // Providers without a wrapper (e.g. Slack today) gracefully fall through —
  // the section header is still in view.
  //
  // Two delivery paths handled here so neither races React's render scheduler:
  //   1) The dispatcher fires a window event — the listener below catches it
  //      whenever SettingsView is already mounted at dispatch time.
  //   2) The dispatcher also stashes the provider in a module-scoped ref. On
  //      mount, this effect drains it via `consumePendingFocusProvider()` so
  //      a click that mounted SettingsView (e.g. AutomationsView's "Connect
  //      Gmail →" button switching to the settings tab) still focuses the
  //      panel even though the event fired before the listener registered.
  // Stale-flash guard: keep the latest setTimeout id in a ref and clear the
  // previous one on each new focus so a double-click does not clip the
  // second flash short.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    function focusProvider(provider: string) {
      if (!provider) return;
      setActiveSection("integrations");
      queueContentAlignment("integrations");
      requestAnimationFrame(() => {
        const node = document.querySelector<HTMLElement>(
          `[data-connector="${CSS.escape(provider)}"]`,
        );
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "start" });
        node.classList.add("connector-flash");
        if (flashTimerRef.current !== null) {
          clearTimeout(flashTimerRef.current);
        }
        flashTimerRef.current = setTimeout(() => {
          node.classList.remove("connector-flash");
          flashTimerRef.current = null;
        }, 1800);
      });
    }

    function handle(event: Event) {
      const detail = (event as CustomEvent<SettingsFocusConnectorDetail>)
        .detail;
      if (!detail?.provider) return;
      // Consume the stash here too — the dispatcher always writes it before
      // firing the event, but if we're already mounted the event path wins
      // and the stash would otherwise persist and re-fire on the next mount
      // (e.g. tab navigation) as a spurious scroll/flash.
      consumePendingFocusProvider();
      focusProvider(detail.provider);
    }

    // Drain any pending provider stashed before this mount.
    const pending = consumePendingFocusProvider();
    if (pending) focusProvider(pending);

    window.addEventListener(SETTINGS_FOCUS_CONNECTOR_EVENT, handle);
    return () => {
      window.removeEventListener(SETTINGS_FOCUS_CONNECTOR_EVENT, handle);
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, [queueContentAlignment]);

  const handleSectionChange = useCallback(
    (sectionId: string) => {
      setActiveSection(sectionId);
      replaceSettingsHash(sectionId);
      queueSectionAlignment(sectionId);
    },
    [queueSectionAlignment],
  );

  useEffect(() => {
    if (visibleSections.length === 0) return;
    if (!visibleSectionIds.has(activeSection)) {
      setActiveSection(visibleSections[0].id);
    }
  }, [activeSection, visibleSectionIds, visibleSections]);

  useEffect(() => {
    if (!initialAlignmentPendingRef.current) return;
    if (!visibleSectionIds.has(activeSection)) return;
    queueSectionAlignment(activeSection);
  }, [activeSection, queueSectionAlignment, visibleSectionIds]);

  useEffect(() => {
    if (!initialSection) return;
    handleSectionChange(initialSection);
  }, [handleSectionChange, initialSection]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const nextSection = readSettingsHashSection();
      if (!nextSection || !visibleSectionIds.has(nextSection)) return;
      handleSectionChange(nextSection);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [handleSectionChange, visibleSectionIds]);

  useEffect(() => {
    const shell = shellRef.current;
    const root = contentContainerRef.current;
    if (!shell || !root) return;

    const handleScroll = () => {
      if (initialAlignmentPendingRef.current) return;

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

      const rootRect = root.getBoundingClientRect();
      const activeAnchorOffset = Math.min(
        320,
        Math.max(180, root.clientHeight * 0.35),
      );
      let currentSection = sections[0].id;

      for (const { id, el } of sections) {
        const elRect = el.getBoundingClientRect();
        if (elRect.top - rootRect.top <= activeAnchorOffset) {
          currentSection = id;
        }
      }

      setActiveSection((prev) => {
        if (prev === currentSection) return prev;
        replaceSettingsHash(currentSection);
        return currentSection;
      });
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

  const settingsSidebar = (
    <AppPageSidebar
      testId="settings-sidebar"
      collapsible
      resizable
      contentIdentity="settings"
      collapseButtonTestId="settings-sidebar-collapse-toggle"
      expandButtonTestId="settings-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse settings"
      expandButtonAriaLabel="Expand settings"
      mobileTitle={t("nav.settings")}
      mobileMeta={
        activeSectionDef ? settingsSectionLabel(activeSectionDef, t) : undefined
      }
    >
      <SidebarScrollRegion className="pt-0">
        <SidebarPanel>
          <nav className="space-y-1.5" aria-label={t("nav.settings")}>
            {visibleSections.map((section) => {
              const isActive = activeSection === section.id;
              const Icon = section.icon;
              const toneClass = SECTION_TONE_ICON_CLASS[section.tone];
              const tooltip = settingsSectionTooltip(section, t);
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
                    title={tooltip}
                  >
                    <SidebarContent.ItemIcon
                      active={isActive}
                      className={cn(
                        "mt-0 h-8 w-8 rounded-lg p-1.5",
                        !isActive && toneClass,
                      )}
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
          ref={registerContentItem("identity")}
        >
          <IdentitySettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("ai-model") && (
        <SettingsSection
          id="ai-model"
          title={t("common.providers", { defaultValue: "Providers" })}
          ref={registerContentItem("ai-model")}
        >
          <ProviderSwitcher />
        </SettingsSection>
      )}

      {visibleSectionIds.has("runtime") && (
        <SettingsSection
          id="runtime"
          title={t("settings.sections.runtime.label", {
            defaultValue: "Runtime",
          })}
          ref={registerContentItem("runtime")}
        >
          <RuntimeSettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("appearance") && (
        <SettingsSection
          id="appearance"
          title={t("settings.sections.appearance.label", {
            defaultValue: "Appearance",
          })}
          ref={registerContentItem("appearance")}
        >
          <AppearanceSettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("capabilities") && (
        <SettingsSection
          id="capabilities"
          title={t("common.capabilities", { defaultValue: "Capabilities" })}
          ref={registerContentItem("capabilities")}
        >
          <CapabilitiesSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("apps") && (
        <SettingsSection
          id="apps"
          title={t("settings.sections.apps.label", { defaultValue: "Apps" })}
          ref={registerContentItem("apps")}
        >
          <AppsManagementSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("app-permissions") && (
        <SettingsSection
          id="app-permissions"
          title={t("settings.sections.apppermissions.label", {
            defaultValue: "App Permissions",
          })}
          ref={registerContentItem("app-permissions")}
        >
          <AppPermissionsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("wallet-rpc") && (
        <SettingsSection
          id="wallet-rpc"
          title={t("settings.sections.walletrpc.label", {
            defaultValue: "Wallet & RPC",
          })}
          bodyClassName="p-4 sm:p-5"
          ref={registerContentItem("wallet-rpc")}
        >
          <div className="space-y-6">
            <WalletKeysSection />
            <ConfigPageView embedded />
          </div>
        </SettingsSection>
      )}

      {visibleSectionIds.has("permissions") && (
        <SettingsSection
          id="permissions"
          title={t("common.permissions", { defaultValue: "Permissions" })}
          ref={registerContentItem("permissions")}
        >
          <PermissionsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("secrets") && (
        <SettingsSection
          id="secrets"
          title={t("settings.sections.secrets.label", { defaultValue: "Vault" })}
          ref={registerContentItem("secrets")}
        >
          <SecretsManagerSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("security") && (
        <SettingsSection
          id="security"
          title={t("settings.sections.security.label", {
            defaultValue: "Security",
          })}
          ref={registerContentItem("security")}
        >
          <SecuritySettingsSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("updates") && (
        <SettingsSection
          id="updates"
          title={t("settings.sections.updates.label", {
            defaultValue: "Updates",
          })}
          ref={registerContentItem("updates")}
        >
          <UpdatesSection />
        </SettingsSection>
      )}

      {visibleSectionIds.has("advanced") && (
        <SettingsSection
          id="advanced"
          title={t("settings.sections.backupReset.label", {
            defaultValue: "Backup & Reset",
          })}
          ref={registerContentItem("advanced")}
        >
          <AdvancedSection />
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
