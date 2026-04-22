import {
  Sidebar,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import { Play, Search, Star } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { type AppIdentitySource, getAppCategoryIcon } from "./app-identity";
import {
  APP_CATALOG_SECTION_LABELS,
  type AppCatalogSectionKey,
  getAppCatalogSectionKey,
  getAppShortName,
} from "./helpers";

interface AppsSidebarProps {
  apps: RegistryAppInfo[];
  runs: AppRunSummary[];
  activeAppNames: ReadonlySet<string>;
  favoriteAppNames: ReadonlySet<string>;
  selectedAppName: string | null;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onLaunchApp: (app: RegistryAppInfo) => void;
  onOpenRun: (run: AppRunSummary) => void;
}

const GENRE_ORDER: readonly AppCatalogSectionKey[] = [
  "games",
  "finance",
  "lifeManagement",
  "developerUtilities",
  "other",
];

function matchesSearch(
  app: Pick<RegistryAppInfo, "name" | "displayName" | "description">,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  return (
    app.name.toLowerCase().includes(normalizedQuery) ||
    (app.displayName ?? "").toLowerCase().includes(normalizedQuery) ||
    (app.description ?? "").toLowerCase().includes(normalizedQuery)
  );
}

export function AppsSidebar({
  apps,
  runs,
  activeAppNames,
  favoriteAppNames,
  selectedAppName,
  searchQuery,
  onSearchQueryChange,
  onLaunchApp,
  onOpenRun,
}: AppsSidebarProps) {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredApps = useMemo(
    () => apps.filter((app) => matchesSearch(app, normalizedQuery)),
    [apps, normalizedQuery],
  );

  const appsByName = useMemo(() => {
    const map = new Map<string, RegistryAppInfo>();
    for (const app of apps) map.set(app.name, app);
    return map;
  }, [apps]);

  const runningEntries = useMemo(() => {
    return runs
      .map((run) => {
        const app = appsByName.get(run.appName);
        const displayName = app?.displayName ?? run.displayName ?? run.appName;
        const description = app?.description ?? "";
        if (
          normalizedQuery &&
          !matchesSearch(
            { name: run.appName, displayName, description },
            normalizedQuery,
          )
        ) {
          return null;
        }
        return { run, app, displayName };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
  }, [appsByName, normalizedQuery, runs]);

  const favoriteEntries = useMemo(() => {
    return filteredApps
      .filter((app) => favoriteAppNames.has(app.name))
      .sort((a, b) =>
        (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
      );
  }, [favoriteAppNames, filteredApps]);

  const genreEntries = useMemo(() => {
    const buckets = new Map<AppCatalogSectionKey, RegistryAppInfo[]>();
    for (const app of filteredApps) {
      if (favoriteAppNames.has(app.name)) continue;
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
  }, [favoriteAppNames, filteredApps]);

  const hasAnyResults =
    runningEntries.length > 0 ||
    favoriteEntries.length > 0 ||
    genreEntries.length > 0;

  return (
    <Sidebar
      testId="apps-sidebar"
      collapsible
      contentIdentity="apps"
      collapseButtonAriaLabel="Collapse apps sidebar"
      expandButtonAriaLabel="Expand apps sidebar"
      header={undefined}
      className="!mt-0 !h-full !bg-none !bg-transparent !rounded-none !border-0 !border-r !border-r-border/30 !shadow-none !backdrop-blur-none !ring-0"
      headerClassName="!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden"
      collapseButtonClassName="!h-7 !w-7 !border-0 !bg-transparent !shadow-none hover:!bg-bg-muted/60"
    >
      <SidebarScrollRegion className="px-1 pb-3 pt-0">
        <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
          <div className="sticky top-0 z-10 bg-bg/60 px-1 py-1.5 backdrop-blur-sm">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted/60"
                aria-hidden
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder="Search apps"
                aria-label="Search apps"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-[var(--radius-sm)] border border-border/30 bg-bg/40 pl-7 pr-2 py-1 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent/40 focus:outline-none"
              />
            </div>
          </div>

          {!hasAnyResults ? (
            <div className="px-3 py-4 text-2xs text-muted/70">
              {normalizedQuery ? "No matching apps" : "No apps available"}
            </div>
          ) : (
            <div className="mt-1 space-y-3">
              {runningEntries.length > 0 && (
                <AppsSidebarSection
                  label="Running"
                  icon={<Play className="h-3 w-3" aria-hidden />}
                  count={runningEntries.length}
                >
                  {runningEntries.map(({ run, app, displayName }) => (
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

              {favoriteEntries.length > 0 && (
                <AppsSidebarSection
                  label="Favorites"
                  icon={<Star className="h-3 w-3" aria-hidden />}
                  count={favoriteEntries.length}
                >
                  {favoriteEntries.map((app) => (
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

              {genreEntries.map((section) => (
                <AppsSidebarSection
                  key={section.key}
                  label={section.label}
                  count={section.apps.length}
                >
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
    </Sidebar>
  );
}

function AppsSidebarSection({
  label,
  icon,
  count,
  children,
}: {
  label: string;
  icon?: ReactNode;
  count: number;
  children: ReactNode;
}) {
  return (
    <div>
      <SidebarContent.SectionHeader
        className="px-2 !mb-1"
        meta={<span>{count}</span>}
      >
        <SidebarContent.SectionLabel className="inline-flex items-center gap-1.5 text-[0.625rem]">
          {icon}
          {label}
        </SidebarContent.SectionLabel>
      </SidebarContent.SectionHeader>
      <div className="space-y-0.5">{children}</div>
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
  const Icon = getAppCategoryIcon(identitySource);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={`group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left transition-colors ${
        selected
          ? "bg-accent/15 text-txt"
          : "text-txt hover:bg-bg-muted/50"
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
          aria-label="Running"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_0_2px_rgba(16,185,129,0.25)]"
        />
      ) : null}
    </button>
  );
}
