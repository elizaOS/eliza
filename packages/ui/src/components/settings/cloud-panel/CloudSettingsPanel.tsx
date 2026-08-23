/**
 * Cloud settings panel — the main shell for the cloud-only desktop settings.
 *
 * Replaces the legacy registry-driven SettingsView for cloud-only builds.
 * Uses an invisible top drag strip (no HTML window controls) and a NuPhy UI
 * sidebar + content layout. Responsive: below 700px collapses to a hub list
 * with a back button.
 */
import { ArrowLeft } from "lucide-react";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { cn } from "../../../lib/utils";
import { useAppSelector } from "../../../state";
import { ErrorBoundary } from "../../ui/error-boundary";
import {
  CloudAccountMenu,
  type CloudAccountNavigationState,
  type CloudPanelNavigationOptions,
  CloudSettingsSidebar,
} from "./CloudSettingsSidebar";
import { useHasCloudManagementCredential } from "./cloud-management-auth";
import {
  navigateCloudPanel,
  readCloudPanelHash,
  replaceCloudPanel,
  subscribeCloudPanelHash,
} from "./cloud-panel-routing";
import {
  CLOUD_PANEL_SECTIONS,
  type CloudPanelSection,
  groupedCloudPanelSections,
  resolveCloudPanelSection,
} from "./cloud-panel-sections";

/** Transparent client-area titlebar used to move the detached native window. */
export function CloudSettingsDragStrip() {
  return (
    <div
      aria-hidden="true"
      className="nuphy-window-drag-strip"
      data-window-titlebar="true"
    />
  );
}

function SectionLoading({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={`Loading ${label}`}
      className="space-y-3 py-1"
      role="status"
    >
      <span className="sr-only">Loading {label}</span>
      <div className="h-4 w-2/5 animate-pulse rounded-sm bg-[var(--fill)] motion-reduce:animate-none" />
      <div className="h-11 w-full animate-pulse rounded-sm bg-[var(--fill)] motion-reduce:animate-none" />
      <div className="h-11 w-full animate-pulse rounded-sm bg-[var(--fill)] motion-reduce:animate-none" />
    </div>
  );
}

function SectionError({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-left"
    >
      <p className="text-sm font-semibold text-[var(--destructive)]">
        {label} failed to load
      </p>
      <p className="max-w-prose break-words text-xs text-[var(--muted-foreground)]">
        {error.message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition-colors hover:border-[var(--ring)]"
      >
        Retry
      </button>
    </div>
  );
}

function ElizaCloudSectionTheme({ children }: { children: ReactNode }) {
  return (
    // Lifted Cloud bodies use Eliza's `text-muted` and `text-accent`
    // semantics. The marker lets nuphy-scope.css restore only those text
    // utilities without changing the same tokens used by NuPhy fills.
    <div data-cloud-section-theme="eliza">{children}</div>
  );
}

function SectionContent({ section }: { section: CloudPanelSection }) {
  const Component = section.Component;
  const body = (
    <ErrorBoundary
      key={section.id}
      fallback={(error: Error, reset: () => void) => (
        <SectionError label={section.label} error={error} onRetry={reset} />
      )}
    >
      <Suspense fallback={<SectionLoading label={section.label} />}>
        <Component />
      </Suspense>
    </ErrorBoundary>
  );
  return (
    <>
      <h1 className="sr-only">{section.label}</h1>
      {section.placement === "account-footer" ? (
        <ElizaCloudSectionTheme>{body}</ElizaCloudSectionTheme>
      ) : (
        body
      )}
    </>
  );
}

function HubList({
  accountState,
  activeSection,
  onSignOutAttemptFinish,
  onSignOutAttemptStart,
  onSelect,
}: {
  accountState: CloudAccountNavigationState;
  activeSection: string;
  onSignOutAttemptFinish: () => void;
  onSignOutAttemptStart: () => void;
  onSelect: (id: string, options?: CloudPanelNavigationOptions) => void;
}) {
  const grouped = groupedCloudPanelSections();
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {Object.entries(grouped).map(([groupId, sections]) => (
          <div key={groupId} className="mb-5 last:mb-0">
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              {groupId.charAt(0).toUpperCase() + groupId.slice(1)}
            </h2>
            <div className="space-y-0.5">
              {sections.map((section) => {
                const Icon = section.icon;
                const active = section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => onSelect(section.id)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                      active ? "bg-[var(--accent)]" : "hover:bg-[var(--fill)]",
                    )}
                  >
                    <Icon
                      className={cn(
                        "mt-0.5 h-5 w-5 shrink-0",
                        active
                          ? "text-[var(--foreground)]"
                          : "text-[var(--muted-foreground)]",
                      )}
                    />
                    <div className="min-w-0">
                      <div
                        className={cn(
                          "text-sm",
                          active
                            ? "font-medium text-[var(--foreground)]"
                            : "text-[var(--foreground)]",
                        )}
                      >
                        {section.label}
                      </div>
                      <div className="truncate text-xs text-[var(--muted-foreground)]">
                        {section.subtitle}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <CloudAccountMenu
        accountState={accountState}
        activeSection={activeSection}
        onSignOutAttemptFinish={onSignOutAttemptFinish}
        onSignOutAttemptStart={onSignOutAttemptStart}
        onSelect={onSelect}
      />
    </div>
  );
}

function documentUsesDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  return (
    root.getAttribute("data-theme") === "dark" ||
    root.classList.contains("dark")
  );
}

export function CloudSettingsPanel() {
  const [sectionId, setSectionId] = useState<string>(() =>
    readCloudPanelHash(),
  );
  const isWide = useMediaQuery("(min-width: 700px)");
  const [narrowView, setNarrowView] = useState<"hub" | "section">(() =>
    typeof window !== "undefined" && window.location.hash ? "section" : "hub",
  );
  const [isDark, setIsDark] = useState(documentUsesDarkTheme);
  const [accountSignOutAttempt, setAccountSignOutAttempt] = useState<
    "idle" | "pending" | "finished"
  >("idle");
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const hasManagementCredential = useHasCloudManagementCredential();
  const observedAccountSessionAvailable =
    elizaCloudConnected || hasManagementCredential;
  const accountDestinationsAvailable =
    observedAccountSessionAvailable && accountSignOutAttempt === "idle";
  const accountNavigationState: CloudAccountNavigationState =
    !observedAccountSessionAvailable
      ? "disconnected"
      : accountSignOutAttempt === "idle"
        ? "connected"
        : accountSignOutAttempt === "pending"
          ? "signing-out"
          : "sign-out-failed";

  // Keep account routes fail-closed throughout an attempt. A settled attempt
  // with a still-observed session becomes an explicit retry state; only an
  // observably absent credential may clear the suppression automatically.
  useEffect(() => {
    if (!observedAccountSessionAvailable && accountSignOutAttempt !== "idle") {
      setAccountSignOutAttempt("idle");
    }
  }, [accountSignOutAttempt, observedAccountSessionAvailable]);

  // Sync with URL hash.
  useEffect(() => {
    return subscribeCloudPanelHash((id) => setSectionId(id));
  }, []);

  // Track the app's theme (data-theme attribute on <html>) to toggle the
  // .nuphy-dark class. LightningCSS transforms .dark and [data-theme="dark"]
  // selectors, so we use a custom class name it won't recognize.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => {
      setIsDark(documentUsesDarkTheme());
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);

  const handleSelect = (id: string, options?: CloudPanelNavigationOptions) => {
    const requested = resolveCloudPanelSection(id);
    const requestedSection = CLOUD_PANEL_SECTIONS.find(
      (candidate) => candidate.id === requested,
    );
    const resolved =
      requestedSection?.placement === "account-footer" &&
      !accountDestinationsAvailable
        ? "general"
        : requested;
    setSectionId(resolved);
    if (options?.showSection !== false) setNarrowView("section");
    if (options?.replace) {
      replaceCloudPanel(resolved);
    } else {
      navigateCloudPanel(resolved);
    }
  };

  const requestedSection = CLOUD_PANEL_SECTIONS.find(
    (candidate) => candidate.id === sectionId,
  );
  const accountDestinationBlocked =
    requestedSection?.placement === "account-footer" &&
    !accountDestinationsAvailable;
  const section = accountDestinationBlocked
    ? CLOUD_PANEL_SECTIONS.find((candidate) => candidate.id === "general")
    : requestedSection;
  const activeSectionId = section?.id ?? "general";
  const scopeClass = isDark ? "nuphy-scope nuphy-dark" : "nuphy-scope";

  // Account-only bodies must never survive credential loss or a disconnected
  // deep link. Replace (rather than push) so Back cannot revive the route.
  useEffect(() => {
    if (!accountDestinationBlocked) return;
    setSectionId("general");
    replaceCloudPanel("general");
  }, [accountDestinationBlocked]);

  // Narrow layout: hub list → back-button subview.
  if (!isWide) {
    const showHub = narrowView === "hub";
    return (
      <div
        className={cn(
          scopeClass,
          "flex h-full flex-col bg-[var(--canvas)] pt-8",
        )}
      >
        <CloudSettingsDragStrip />
        {showHub ? (
          <HubList
            accountState={accountNavigationState}
            activeSection={activeSectionId}
            onSignOutAttemptFinish={() => setAccountSignOutAttempt("finished")}
            onSignOutAttemptStart={() => setAccountSignOutAttempt("pending")}
            onSelect={handleSelect}
          />
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <button
              type="button"
              onClick={() => setNarrowView("hub")}
              className="flex items-center gap-1.5 border-b border-[var(--hairline)] px-4 py-2.5 text-sm text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              <ArrowLeft className="h-4 w-4" />
              Settings
            </button>
            <div className="flex-1 overflow-y-auto px-4 py-6">
              {section && <SectionContent section={section} />}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Wide layout: sidebar + content side-by-side.
  return (
    <div className={cn(scopeClass, "flex h-full bg-[var(--canvas)]")}>
      <CloudSettingsDragStrip />
      <CloudSettingsSidebar
        accountState={accountNavigationState}
        activeSection={activeSectionId}
        onSignOutAttemptFinish={() => setAccountSignOutAttempt("finished")}
        onSignOutAttemptStart={() => setAccountSignOutAttempt("pending")}
        onSelect={handleSelect}
      />
      <main className="flex-1 overflow-y-auto bg-[var(--canvas)] bg-dotted pt-8">
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
          {section ? (
            <SectionContent section={section} />
          ) : (
            <SectionLoading label="Settings" />
          )}
        </div>
      </main>
    </div>
  );
}
