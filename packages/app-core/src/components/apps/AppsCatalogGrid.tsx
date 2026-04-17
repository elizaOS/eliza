import { Button, Input } from "@elizaos/ui";
import type { RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { AppIdentityTile } from "./app-identity";
import {
  getAppCatalogSectionLabel,
  getAppShortName,
  groupAppsForCatalog,
} from "./helpers";

interface AppsCatalogGridProps {
  activeAppNames: Set<string>;
  error: string | null;
  favoriteAppNames: Set<string>;
  loading: boolean;
  searchQuery: string;
  visibleApps: RegistryAppInfo[];
  onLaunch: (app: RegistryAppInfo) => void;
  onRefresh: () => void;
  onSearchQueryChange: (value: string) => void;
  onToggleFavorite: (appName: string) => void;
}

export function AppsCatalogGrid({
  activeAppNames,
  error,
  favoriteAppNames,
  loading,
  searchQuery,
  visibleApps,
  onLaunch,
  onRefresh,
  onSearchQueryChange,
  onToggleFavorite,
}: AppsCatalogGridProps) {
  const { t } = useApp();
  const sections = groupAppsForCatalog(visibleApps, favoriteAppNames);
  return (
    <div data-testid="apps-catalog-grid">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          type="text"
          aria-label={t("appsview.Search", { defaultValue: "Search apps" })}
          placeholder={t("appsview.SearchPlaceholder")}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          className="min-w-[200px] flex-1 rounded-xl border-border/50 bg-card/86 text-xs text-txt placeholder:text-muted focus:border-accent"
        />
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl px-3 shadow-sm"
          onClick={onRefresh}
        >
          {t("common.refresh")}
        </Button>
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs-tight text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-border/30 bg-card/72 py-16 text-center text-xs text-muted">
          {t("appsview.Loading")}
        </div>
      ) : visibleApps.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/35 bg-card/72 px-6 py-16 text-center">
          <div className="text-xs font-medium text-muted-strong">
            {searchQuery
              ? t("appsview.NoAppsMatchSearch")
              : t("appsview.NoAppsAvailable")}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map((section) => (
            <section
              key={section.key}
              data-testid={`apps-section-${section.key}`}
              className="space-y-3"
            >
              <div className="flex items-center gap-3">
                <h2 className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted-strong">
                  {section.label}
                </h2>
                <div className="h-px flex-1 bg-border/30" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.apps.map((app) => {
                  const isActive = activeAppNames.has(app.name);
                  const isFavorite = favoriteAppNames.has(app.name);
                  const displayName = app.displayName ?? getAppShortName(app);

                  return (
                    <div
                      key={app.name}
                      className="group relative rounded-2xl border border-border/35 bg-card/72 transition-all hover:border-accent/25 hover:bg-bg-hover/70 focus-within:ring-2 focus-within:ring-accent/35"
                    >
                      <button
                        type="button"
                        data-testid={`app-card-${app.name.replace(/[^a-z0-9]+/gi, "-")}`}
                        title={displayName}
                        aria-label={displayName}
                        className="flex w-full flex-col p-4 text-left focus-visible:outline-none"
                        onClick={() => onLaunch(app)}
                      >
                        <div className="flex items-start justify-between gap-3 pe-8">
                          <div className="flex items-center gap-3">
                            <AppIdentityTile
                              app={app}
                              active={isActive}
                              size="sm"
                            />
                            <div>
                              <div className="text-sm font-semibold text-txt">
                                {displayName}
                              </div>
                              <div className="text-xs-tight text-muted-strong">
                                {getAppCatalogSectionLabel(app)}
                              </div>
                            </div>
                          </div>
                        </div>
                        <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-strong">
                          {app.description ||
                            "Launch and manage this agent experience."}
                        </p>
                      </button>
                      <button
                        type="button"
                        aria-label={
                          isFavorite
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        className={`absolute right-4 top-4 shrink-0 p-1 transition-colors ${
                          isFavorite
                            ? "text-warn"
                            : "text-muted/40 opacity-0 group-hover:opacity-100 hover:text-warn"
                        }`}
                        onClick={() => onToggleFavorite(app.name)}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill={isFavorite ? "currentColor" : "none"}
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <title>Favorite</title>
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
