import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { Play, Star } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { useTranslation } from "../../state/TranslationContext";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { type AppIdentitySource, getAppCategoryIcon } from "./app-identity";
import {
  APP_CATALOG_SECTION_LABELS,
  type AppCatalogSectionKey,
  getAppCatalogSectionKey,
  getAppShortName,
} from "./helpers";

interface AppsSidebarProps {
  apps: RegistryAppInfo[];
  browseApps: RegistryAppInfo[];
  runs: AppRunSummary[];
  activeAppNames: ReadonlySet<string>;
  favoriteAppNames: ReadonlySet<string>;
  selectedAppName: string | null;
  /** Controlled collapsed state. */
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  /** Controlled width in px (expanded only; ignored when collapsed). */
  width: number;
  onWidthChange: (next: number) => void;
  minWidth?: number;
  maxWidth?: number;
  onLaunchApp: (app: RegistryAppInfo) => void;
  onOpenRun: (run: AppRunSummary) => void;
}

const GENRE_ORDER: readonly AppCatalogSectionKey[] = [
  "games",
  "finance",
  "developerUtilities",
  "other",
];

export function AppsSidebar({
  apps,
  browseApps,
  runs,
  activeAppNames,
  favoriteAppNames,
  selectedAppName,
  collapsed,
  onCollapsedChange,
  width,
  onWidthChange,
  minWidth = 220,
  maxWidth = 420,
  onLaunchApp,
  onOpenRun,
}: AppsSidebarProps) {
  const appsByName = useMemo(() => {
    const map = new Map<string, RegistryAppInfo>();
    for (const app of apps) map.set(app.name, app);
    return map;
  }, [apps]);

  const featuredEntries = useMemo(() => {
    return browseApps.filter(
      (app) =>
        getAppCatalogSectionKey(app) === "featured" &&
        !favoriteAppNames.has(app.name),
    );
  }, [browseApps, favoriteAppNames]);

  const starredEntries = useMemo(() => {
    return browseApps
      .filter((app) => favoriteAppNames.has(app.name))
      .sort((a, b) =>
        (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
      );
  }, [browseApps, favoriteAppNames]);

  const activeEntries = useMemo(() => {
    return runs
      .map((run) => {
        const app = appsByName.get(run.appName);
        const displayName = app?.displayName ?? run.displayName ?? run.appName;
        return { run, app, displayName };
      })
      .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
  }, [appsByName, runs]);

  const featuredAppNames = useMemo(() => {
    return new Set(featuredEntries.map((app) => app.name));
  }, [featuredEntries]);

  const surfacedAppNames = useMemo(() => {
    const set = new Set<string>();
    for (const appName of featuredAppNames) set.add(appName);
    for (const app of starredEntries) set.add(app.name);
    for (const entry of activeEntries) set.add(entry.run.appName);
    return set;
  }, [activeEntries, featuredAppNames, starredEntries]);

  const genreEntries = useMemo(() => {
    const buckets = new Map<AppCatalogSectionKey, RegistryAppInfo[]>();
    for (const app of browseApps) {
      if (surfacedAppNames.has(app.name)) continue;
      const key = getAppCatalogSectionKey(app);
      const list = buckets.get(key) ?? [];
      list.push(app);
      buckets.set(key, list);
    }
    for (const list of buckets.values()) {
      list.sort((a, b) =>
        (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
      );
    }
    return GENRE_ORDER.flatMap((key) => {
      const list = buckets.get(key) ?? [];
      if (list.length === 0) return [];
      return [
        {
          key,
          label: APP_CATALOG_SECTION_LABELS[key],
          apps: list,
        },
      ];
    });
  }, [browseApps, surfacedAppNames]);

  const hasAnyResults =
    featuredEntries.length > 0 ||
    starredEntries.length > 0 ||
    activeEntries.length > 0 ||
    genreEntries.length > 0;

  return (
    <AppPageSidebar
      testId="apps-sidebar"
      collapsible
      contentIdentity="apps"
      collapseButtonAriaLabel="Collapse apps sidebar"
      expandButtonAriaLabel="Expand apps sidebar"
      expandButtonTestId="apps-sidebar-expand-toggle"
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      resizable
      width={width}
      onWidthChange={onWidthChange}
      minWidth={minWidth}
      maxWidth={maxWidth}
      onCollapseRequest={() => onCollapsedChange(true)}
    >
      <SidebarScrollRegion className="scrollbar-hide px-1 pb-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
          {!hasAnyResults ? (
            <div className="px-3 py-4 text-2xs text-muted/70">
              No apps available
            </div>
          ) : (
            <div className="space-y-3">
              {starredEntries.length > 0 && (
                <AppsSidebarSection
                  label="Starred"
                  icon={<Star className="h-3 w-3" aria-hidden />}
                >
                  {starredEntries.map((app) => (
                    <AppsSidebarAppButton
                      key={app.name}
                      name={app.name}
                      displayName={app.displayName ?? getAppShortName(app)}
                      active={activeAppNames.has(app.name)}
                      selected={selectedAppName === app.name}
                      identitySource={app}
                      onClick={() => onLaunchApp(app)}
                    />
                  ))}
                </AppsSidebarSection>
              )}

              {featuredEntries.length > 0 && (
                <AppsSidebarSection
                  label="Featured"
                  icon={<Star className="h-3 w-3" aria-hidden />}
                >
                  {featuredEntries.map((app) => (
                    <AppsSidebarAppButton
                      key={app.name}
                      name={app.name}
                      displayName={app.displayName ?? getAppShortName(app)}
                      active={activeAppNames.has(app.name)}
                      selected={selectedAppName === app.name}
                      identitySource={app}
                      onClick={() => onLaunchApp(app)}
                    />
                  ))}
                </AppsSidebarSection>
              )}

              {activeEntries.length > 0 && (
                <AppsSidebarSection
                  label="Active"
                  icon={<Play className="h-3 w-3" aria-hidden />}
                >
                  {activeEntries.map(({ run, app, displayName }) => (
                    <AppsSidebarAppButton
                      key={run.runId}
                      name={run.appName}
                      displayName={displayName}
                      active
                      selected={selectedAppName === run.appName}
                      identitySource={
                        app ?? {
                          name: run.appName,
                          displayName,
                          icon: null,
                          category: "",
                          description: "",
                        }
                      }
                      onClick={() => onOpenRun(run)}
                    />
                  ))}
                </AppsSidebarSection>
              )}

              {genreEntries.map((section) => (
                <AppsSidebarSection key={section.key} label={section.label}>
                  {section.apps.map((app) => (
                    <AppsSidebarAppButton
                      key={app.name}
                      name={app.name}
                      displayName={app.displayName ?? getAppShortName(app)}
                      active={activeAppNames.has(app.name)}
                      selected={selectedAppName === app.name}
                      identitySource={app}
                      onClick={() => onLaunchApp(app)}
                    />
                  ))}
                </AppsSidebarSection>
              ))}
            </div>
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );
}

function AppsSidebarSection({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <SidebarContent.SectionLabel className="mb-1 inline-flex items-center gap-1.5 px-2 text-[0.625rem]">
        {icon}
        {label}
      </SidebarContent.SectionLabel>
      <div className="space-y-0.5 pl-3">{children}</div>
    </div>
  );
}

interface AppsSidebarAppButtonProps {
  name: string;
  displayName: string;
  active: boolean;
  selected: boolean;
  identitySource: AppIdentitySource;
  onClick: () => void;
}

function AppsSidebarAppButton({
  displayName,
  active,
  selected,
  identitySource,
  onClick,
}: AppsSidebarAppButtonProps) {
  const { t } = useTranslation();
  const Icon = getAppCategoryIcon(identitySource);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={`group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left transition-colors ${
        selected ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50"
      }`}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-muted/70"
        aria-hidden
        strokeWidth={2}
      />
      <span className="min-w-0 flex-1 truncate text-xs-tight">
        {displayName}
      </span>
      {active ? (
        <span
          role="img"
          aria-label={t("appsview.Running")}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_0_2px_rgba(16,185,129,0.25)]"
        />
      ) : null}
    </button>
  );
}
