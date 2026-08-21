/**
 * Cloud settings panel — the main shell for the cloud-only desktop settings.
 *
 * Replaces the legacy registry-driven SettingsView for cloud-only builds.
 * Uses the real native titlebar (no HTML window controls) and a NuPhy UI
 * sidebar + content layout. Responsive: below 700px collapses to a hub list
 * with a back button.
 */
import { ArrowLeft } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { useAppSelector } from "../../../state";
import { cn } from "../../../lib/utils";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { ErrorBoundary } from "../../ui/error-boundary";
import {
  CLOUD_PANEL_SECTIONS,
  type CloudPanelSection,
  groupedCloudPanelSections,
  resolveCloudPanelSection,
} from "./cloud-panel-sections";
import {
  navigateCloudPanel,
  readCloudPanelHash,
  subscribeCloudPanelHash,
} from "./cloud-panel-routing";
import { CloudSettingsSidebar } from "./CloudSettingsSidebar";

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

function SectionContent({ section }: { section: CloudPanelSection }) {
  const Component = section.Component;
  return (
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
}

function HubList({
  activeSection,
  onSelect,
}: {
  activeSection: string;
  onSelect: (id: string) => void;
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
                      active
                        ? "bg-[var(--accent)]"
                        : "hover:bg-[var(--fill)]",
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
    </div>
  );
}

export function CloudSettingsPanel() {
  const [sectionId, setSectionId] = useState<string>(() =>
    readCloudPanelHash(),
  );
  const isWide = useMediaQuery("(min-width: 700px)");
  const [isDark, setIsDark] = useState(false);

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
      setIsDark(
        root.getAttribute("data-theme") === "dark" ||
          root.classList.contains("dark"),
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);

  const handleSelect = (id: string) => {
    const resolved = resolveCloudPanelSection(id);
    setSectionId(resolved);
    navigateCloudPanel(resolved);
  };

  const section = CLOUD_PANEL_SECTIONS.find((s) => s.id === sectionId);
  const scopeClass = isDark ? "nuphy-scope nuphy-dark" : "nuphy-scope";

  // Narrow layout: hub list → back-button subview.
  if (!isWide) {
    const showHub = sectionId === "" || section === undefined;
    return (
      <div className={cn(scopeClass, "flex h-full flex-col bg-[var(--canvas)] pt-8")}>
        {showHub ? (
          <HubList activeSection={sectionId} onSelect={handleSelect} />
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <button
              type="button"
              onClick={() => handleSelect("general")}
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
      <CloudSettingsSidebar
        activeSection={sectionId}
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
