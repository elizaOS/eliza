import { Button } from "@elizaos/ui";
import type { RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { getAppEmoji, getAppShortName } from "./helpers";

interface AppsCatalogGridProps {
  activeAppNames: Set<string>;
  activeGameDisplayName: string;
  error: string | null;
  hasCurrentGame: boolean;
  loading: boolean;
  searchQuery: string;
  selectedAppName: string | null;
  showActiveOnly: boolean;
  visibleApps: RegistryAppInfo[];
  onOpenCurrentGame: () => void;
  onRefresh: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelectApp: (appName: string) => void;
  onToggleActiveOnly: () => void;
}

export function AppsCatalogGrid({
  activeAppNames,
  activeGameDisplayName,
  error,
  hasCurrentGame,
  loading,
  searchQuery,
  selectedAppName,
  showActiveOnly,
  visibleApps,
  onOpenCurrentGame,
  onRefresh,
  onSearchQueryChange,
  onSelectApp,
  onToggleActiveOnly,
}: AppsCatalogGridProps) {
  const { t } = useApp();

  return (
    <>
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          className="w-full px-3 py-2 text-[12px] rounded-xl border border-border bg-surface text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none"
        />
      </div>

      <div className="mb-4 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl shadow-sm"
          onClick={onRefresh}
        >
          {t("appsview.Refresh")}
        </Button>
        <Button
          variant={showActiveOnly ? "default" : "outline"}
          size="sm"
          className="rounded-xl shadow-sm"
          onClick={onToggleActiveOnly}
        >
          {t("appsview.ActiveOnly")}
        </Button>
      </div>

      {hasCurrentGame ? (
        <button
          type="button"
          className="w-full mb-4 px-3 py-2.5 rounded-xl border border-ok/30 bg-ok/5 flex items-center gap-2 cursor-pointer hover:bg-ok/10 transition-colors"
          onClick={onOpenCurrentGame}
        >
          <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
          <span className="text-[11px] font-semibold text-txt flex-1 text-left truncate">
            {activeGameDisplayName || "Game running"}
          </span>
          <span className="text-[10px] text-muted">→</span>
        </button>
      ) : null}

      {error ? (
        <div className="px-3 py-2 border border-danger/30 rounded-xl text-danger text-[11px] mb-4">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="text-center py-16 text-muted text-[12px]">
          Loading...
        </div>
      ) : visibleApps.length === 0 ? (
        <div className="text-center py-16 text-muted text-[12px]">
          {searchQuery ? "No apps found" : "No apps available"}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "14px 4px",
            justifyItems: "center",
          }}
        >
          {visibleApps.map((app) => {
            const isActive = activeAppNames.has(app.name);
            const isSelected = selectedAppName === app.name;
            const displayName = app.displayName ?? getAppShortName(app);

            return (
              <button
                key={app.name}
                type="button"
                className={`phone-app-tile group ${isSelected ? "is-selected" : ""}`}
                title={`Open ${displayName}`}
                aria-label={`Open ${displayName}`}
                onClick={() => onSelectApp(app.name)}
              >
                <div className="phone-app-icon">
                  {isActive ? (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-ok border-2 border-card z-10" />
                  ) : null}
                  <span className="text-xl">{getAppEmoji(app)}</span>
                </div>
                <span className="phone-app-label">{getAppShortName(app)}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
