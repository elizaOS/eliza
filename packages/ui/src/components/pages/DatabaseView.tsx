/**
 * The Database view (`/database`): browse the agent's SQL store — tables, rows,
 * and an ad-hoc query editor — behind a segmented Tables/SQL control.
 *
 * Status, table list, and rows are read through the `client` database API and
 * seeded from `resource-cache` so a revisit paints the last-known shape while it
 * revalidates. Segmented tabs register with the agent surface via ref-less
 * `ViewModeTab` children (the SegmentedControl doesn't forward refs).
 */
import {
  ChevronLeft,
  ChevronRight,
  Database as DatabaseIcon,
  ServerOff,
  Table2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type ColumnInfo,
  client,
  type DatabaseStatus,
  type QueryResult,
  type TableInfo,
  type TableRowsResponse,
} from "../../api";
import { getCached, setCached } from "../../hooks/resource-cache";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useTranslation } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented-control";
import { TableSkeleton } from "../ui/skeleton-layouts";
import {
  CellPopover,
  type DbView,
  PaginationBar,
  ResultsGrid,
  type SortDir,
} from "./database-utils";
import { SqlEditorPanel } from "./SqlEditorPanel";

// The editor-mode SegmentedControl renders its own internal buttons and does
// not forward refs to them, so each mode registers with the agent surface
// through a tiny ref-less child that drives selection via onActivate (mirrors
// SettingsNavButton in SettingsView.tsx).
function ViewModeTab({
  mode,
  label,
  isActive,
  onSelect,
}: {
  mode: DbView;
  label: string;
  isActive: boolean;
  onSelect: (mode: DbView) => void;
}) {
  useAgentElement({
    id: `editor-mode-${mode}`,
    role: "tab",
    label,
    group: "database-editor-modes",
    status: isActive ? "active" : "inactive",
    description: `Switch to the ${label} editor`,
    onActivate: () => onSelect(mode),
  });
  return null;
}

export function DatabaseView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  const { t } = useTranslation();
  const showExternalSidebar = Boolean(leftNav);

  // `t` from useApp is not guaranteed to be referentially stable across
  // renders. Reading it through a ref keeps the data loaders below stable so
  // their effect runs once on mount instead of re-firing every render (which
  // would wipe a freshly-set errorMessage before it ever paints).
  const tRef = useRef(t);
  tRef.current = t;
  // Seed status + table list from the shared cache so a revisit paints the
  // last-known database shape instantly and revalidates silently.
  const cachedStatus = getCached<DatabaseStatus>("db:status");
  const cachedTables = getCached<TableInfo[]>("db:tables");
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(
    cachedStatus?.data ?? null,
  );
  const [tables, setTables] = useState<TableInfo[]>(cachedTables?.data ?? []);
  const [selectedTable, setSelectedTable] = useState("");
  const [tableData, setTableData] = useState<TableRowsResponse | null>(null);
  const [columnMeta, setColumnMeta] = useState<Map<string, ColumnInfo>>(
    new Map(),
  );
  const [view, setView] = useState<DbView>("tables");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sortCol, setSortCol] = useState("");
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [rowOffset, setRowOffset] = useState(0);
  const [cellInspect, setCellInspect] = useState<string | null>(null);
  const [statusLoadError, setStatusLoadError] = useState("");

  // SQL editor state
  const [queryText, setQueryText] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);

  const ROW_LIMIT = 50;

  // Keep `tables` reachable from the stable loadTableData callback without
  // adding it to the dep array (which would re-create the callback and the
  // effects that depend on it).
  const tablesRef = useRef(tables);
  tablesRef.current = tables;

  const loadStatus = useCallback(async (): Promise<DatabaseStatus | null> => {
    try {
      const status = await client.getDatabaseStatus();
      setDbStatus(status);
      setCached("db:status", status);
      setStatusLoadError("");
      return status;
    } catch (err) {
      setStatusLoadError(err instanceof Error ? err.message : String(err));
      setDbStatus({
        provider: "pglite",
        connected: false,
        serverVersion: null,
        tableCount: 0,
        pgliteDataDir: null,
        postgresHost: null,
      });
      return null;
    }
  }, []);

  const loadTables = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    setErrorMessage("");
    try {
      const { tables: t } = await client.getDatabaseTables();
      const next = Array.isArray(t) ? t : [];
      setTables(next);
      setCached("db:tables", next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      // Don't show error if database is simply not connected (cloud mode, agent not running)
      if (!msg.includes("Database not available")) {
        setErrorMessage(
          tRef.current("databaseview.FailedToLoadTables", {
            message: msg,
            defaultValue: "Failed to load tables: {{message}}",
          }),
        );
      }
    }
    setLoading(false);
  }, []);

  const loadTableData = useCallback(
    async (
      tableName: string,
      opts?: { sort?: string; order?: "asc" | "desc"; offset?: number },
    ) => {
      setLoading(true);
      setErrorMessage("");
      try {
        const data = await client.getDatabaseRows(tableName, {
          limit: ROW_LIMIT,
          offset: opts?.offset ?? 0,
          sort: opts?.sort,
          order: opts?.order,
        });
        setTableData(data);
        setSelectedTable(tableName);

        // Get column metadata for the table
        const info = tablesRef.current.find((tbl) => tbl.name === tableName);
        if (info?.columns) {
          const meta = new Map<string, ColumnInfo>();
          for (const col of info.columns) meta.set(col.name, col);
          setColumnMeta(meta);
        }
      } catch (err) {
        // Surface the failure so the user sees why the table did not load,
        // and mark the table as selected so the error renders in context
        // rather than being masked by the "select a table" placeholder.
        setSelectedTable(tableName);
        setTableData(null);
        setErrorMessage(
          tRef.current("databaseview.FailedToLoadTable", {
            message: err instanceof Error ? err.message : "error",
            defaultValue: "Failed to load table: {{message}}",
          }),
        );
      }
      setLoading(false);
    },
    [],
  );

  const handleSort = useCallback(
    (col: string) => {
      let newDir: SortDir;
      if (sortCol !== col) {
        newDir = "asc";
      } else if (sortDir === "asc") {
        newDir = "desc";
      } else {
        newDir = null;
      }
      setSortCol(newDir ? col : "");
      setSortDir(newDir);
      setRowOffset(0);
      if (selectedTable) {
        loadTableData(selectedTable, {
          sort: newDir ? col : undefined,
          order: newDir ?? undefined,
          offset: 0,
        });
      }
    },
    [sortCol, sortDir, selectedTable, loadTableData],
  );

  const handleSelectTable = useCallback(
    (tableName: string) => {
      setSortCol("");
      setSortDir(null);
      setRowOffset(0);
      loadTableData(tableName);
    },
    [loadTableData],
  );

  const handlePrev = useCallback(() => {
    const newOffset = Math.max(0, rowOffset - ROW_LIMIT);
    setRowOffset(newOffset);
    loadTableData(selectedTable, {
      sort: sortDir ? sortCol : undefined,
      order: sortDir ?? undefined,
      offset: newOffset,
    });
  }, [rowOffset, selectedTable, sortCol, sortDir, loadTableData]);

  const handleNext = useCallback(() => {
    const newOffset = rowOffset + ROW_LIMIT;
    setRowOffset(newOffset);
    loadTableData(selectedTable, {
      sort: sortDir ? sortCol : undefined,
      order: sortDir ?? undefined,
      offset: newOffset,
    });
  }, [rowOffset, selectedTable, sortCol, sortDir, loadTableData]);

  const runQuery = useCallback(async () => {
    if (!queryText.trim()) return;
    setQueryLoading(true);
    setErrorMessage("");
    try {
      const result = await client.executeDatabaseQuery(queryText);
      setQueryResult(result);
      setQueryHistory((prev) => {
        const next = [queryText, ...prev.filter((q) => q !== queryText)];
        return next.slice(0, 20);
      });
    } catch (err) {
      setErrorMessage(
        t("databaseview.QueryFailed", {
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Query failed: {{message}}",
        }),
      );
    }
    setQueryLoading(false);
  }, [queryText, t]);

  useEffect(() => {
    const init = async () => {
      const seededStatus = getCached<DatabaseStatus>("db:status");
      const seededTables = getCached<TableInfo[]>("db:tables");
      // Warm revisit: we already know the connection is up and have a table
      // list on screen, so the two revalidations are independent — run them in
      // parallel and silently (no spinner) instead of re-walking the waterfall.
      if (seededStatus?.data.connected && seededTables) {
        await Promise.all([loadStatus(), loadTables({ silent: true })]);
        return;
      }
      // Cold load: status gates tables (don't fetch tables when disconnected).
      const status = await loadStatus();
      if (status?.connected) {
        await loadTables();
      }
    };
    void init();
  }, [loadStatus, loadTables]);

  const filteredTables = useMemo(
    () =>
      tables.filter(
        (t) =>
          !sidebarSearch ||
          t.name.toLowerCase().includes(sidebarSearch.toLowerCase()),
      ),
    [tables, sidebarSearch],
  );

  // The floating chat composer is this view's table filter. While Database is
  // the active view it takes over the composer (placeholder + live draft) and
  // feeds each keystroke into `sidebarSearch` — there's no in-page filter input.
  const filterPlaceholder = t("databaseview.FilterTables");
  const chatBinding = useMemo(
    () => ({ placeholder: filterPlaceholder, onQuery: setSidebarSearch }),
    [filterPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);

  // Revalidate the status + table list silently whenever the window regains
  // focus (and on a slow interval), so the view stays fresh on its own — there
  // is no manual refresh control.
  const revalidate = useCallback(async () => {
    const status = await loadStatus();
    if (status?.connected) {
      await loadTables({ silent: true });
    }
  }, [loadStatus, loadTables]);

  useEffect(() => {
    const onFocus = () => void revalidate();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [revalidate]);

  // Slow background revalidation only ticks while the document is visible; the
  // focus listener above already covers the user-returns case.
  useIntervalWhenDocumentVisible(() => void revalidate(), 30_000);

  const editorModes: Array<{ value: DbView; label: string }> = [
    { value: "tables", label: t("databaseview.TableEditor") },
    { value: "query", label: t("databaseview.SQLEditor") },
  ];

  const viewToggle = (
    <>
      <SegmentedControl
        value={view}
        onValueChange={(v) => setView(v)}
        items={editorModes}
        aria-label={t("databaseview.EditorModes", {
          defaultValue: "Database editor modes",
        })}
        buttonClassName="h-10 flex-1"
      />
      {editorModes.map((mode) => (
        <ViewModeTab
          key={mode.value}
          mode={mode.value}
          label={mode.label}
          isActive={view === mode.value}
          onSelect={setView}
        />
      ))}
    </>
  );

  const sidebarSummary = (
    <div className="mt-4 flex items-center gap-2 px-1 text-sm font-medium text-txt">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          dbStatus?.connected ? "bg-ok" : "bg-danger"
        }`}
      />
      <span>{dbStatus?.provider ?? t("game.connecting")}</span>
    </div>
  );

  // Shared SQL editor props
  const sqlEditorProps = {
    queryText,
    setQueryText,
    queryResult,
    queryLoading,
    runQuery,
    queryHistory,
    onCellClick: (v: string) => setCellInspect(v),
  };

  // Designed empty/setup surfaces. The mode switcher (see setView above) is the
  // in-view control for jumping to the SQL editor; these states describe the
  // condition and the agent covers next steps in chat.
  const disconnectedState = (
    <PagePanel.Empty
      className="flex-1"
      icon={<ServerOff className="h-6 w-6" aria-hidden />}
      title={
        statusLoadError ||
        t("databaseview.StartAgentToUseDatabase", {
          defaultValue: "Start the agent to use the database.",
        })
      }
    />
  );

  const noTableSelectedState = (
    <PagePanel.Empty
      className="flex-1"
      icon={<Table2 className="h-6 w-6" aria-hidden />}
      title={t("databaseview.SelectATable")}
    />
  );

  const emptyTableState = (
    <PagePanel.Empty
      className="flex-1"
      icon={<DatabaseIcon className="h-6 w-6" aria-hidden />}
      title={t("databaseview.NoDataInsertViaSql", {
        defaultValue: "No data yet. Insert rows via the SQL editor.",
      })}
    />
  );

  const filteredCountLabel = sidebarSearch
    ? t("databaseview.FilteredCount", {
        shown: filteredTables.length,
        total: tables.length,
        defaultValue: "Filtered: {{shown}}/{{total}}",
      })
    : null;

  if (showExternalSidebar) {
    const dbSidebar = (
      <AppPageSidebar
        testId="database-sidebar"
        collapsible
        contentIdentity="database"
        collapsedRailItems={filteredTables.map((table) => (
          <SidebarContent.RailItem
            key={table.name}
            aria-label={table.name}
            title={table.name}
            active={selectedTable === table.name}
            onClick={() => handleSelectTable(table.name)}
          >
            {table.name.slice(0, 1).toUpperCase()}
          </SidebarContent.RailItem>
        ))}
      >
        <SidebarPanel>
          <div className="space-y-3 pt-1">
            {leftNav}
            {viewToggle}
            {sidebarSummary}
          </div>

          {view === "tables" ? (
            <>
              {filteredCountLabel ? (
                <div className="mt-5 px-1 text-xs-tight font-medium text-muted">
                  {filteredCountLabel}
                </div>
              ) : null}

              <SidebarScrollRegion className="mt-4 space-y-1.5">
                {loading && tables.length === 0 ? (
                  <PagePanel
                    variant="inset"
                    className="rounded-sm px-3 py-4 text-center text-xs text-muted"
                  >
                    {t("appsview.Loading")}
                  </PagePanel>
                ) : (
                  filteredTables.map((table) => (
                    <SidebarContent.Item
                      key={table.name}
                      active={selectedTable === table.name}
                      onClick={() => handleSelectTable(table.name)}
                      className="gap-2"
                    >
                      <SidebarContent.ItemIcon
                        active={selectedTable === table.name}
                      >
                        {table.name.slice(0, 1).toUpperCase()}
                      </SidebarContent.ItemIcon>
                      <SidebarContent.ItemBody>
                        <SidebarContent.ItemTitle>
                          {table.name}
                        </SidebarContent.ItemTitle>
                        <SidebarContent.ItemDescription>
                          {t("databaseview.RowCountLabel", {
                            count: (table.rowCount ?? 0).toLocaleString(
                              "en-US",
                            ),
                            defaultValue: "{{count}} rows",
                          })}
                        </SidebarContent.ItemDescription>
                      </SidebarContent.ItemBody>
                    </SidebarContent.Item>
                  ))
                )}
              </SidebarScrollRegion>
            </>
          ) : queryHistory.length > 0 ? (
            <SidebarScrollRegion className="mt-5 space-y-1.5">
              <div className="px-1 text-xs-tight font-medium text-muted">
                {t("databaseview.RecentQueries")}
              </div>
              {queryHistory.slice(0, 8).map((q) => (
                <Button
                  variant="ghost"
                  key={q}
                  className="h-auto w-full justify-start rounded-sm px-3 py-2 text-left text-xs-tight font-mono text-muted-strong hover:text-txt"
                  onClick={() => setQueryText(q)}
                >
                  <span className="truncate">{q}</span>
                </Button>
              ))}
            </SidebarScrollRegion>
          ) : null}
        </SidebarPanel>
      </AppPageSidebar>
    );

    return (
      <PageLayout
        data-testid="database-view"
        sidebar={dbSidebar}
        contentHeader={contentHeader}
        contentInnerClassName="w-full min-h-0"
      >
        <div className="flex min-h-0 flex-1 flex-col w-full">
          {errorMessage ? (
            <div className="mb-4 rounded-sm border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
              {errorMessage}
            </div>
          ) : null}

          {dbStatus && !dbStatus.connected ? (
            disconnectedState
          ) : view === "tables" ? (
            <div className="flex min-h-0 flex-1 flex-col w-full">
              {!selectedTable ? (
                noTableSelectedState
              ) : loading && !tableData ? (
                <PagePanel
                  variant="surface"
                  className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden p-3"
                >
                  <TableSkeleton rows={10} columns={5} />
                </PagePanel>
              ) : tableData ? (
                <>
                  <PagePanel
                    variant="surface"
                    as="section"
                    className="px-5 py-5 sm:px-6"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <h1 className="text-2xl font-semibold text-txt-strong">
                          {selectedTable}
                        </h1>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {columnMeta.size > 0 && (
                          <MetaPill>
                            {columnMeta.size} {t("databaseview.columns")}
                          </MetaPill>
                        )}
                        <MetaPill>
                          {tableData.total.toLocaleString("en-US")}{" "}
                          {t("common.rows")}
                        </MetaPill>
                      </div>
                    </div>
                  </PagePanel>

                  <PagePanel
                    variant="surface"
                    className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden p-3"
                  >
                    <div className="flex-1 min-h-0">
                      {tableData.rows.length === 0 ? (
                        emptyTableState
                      ) : (
                        <ResultsGrid
                          columns={tableData.columns}
                          rows={tableData.rows}
                          columnMeta={columnMeta}
                          sortCol={sortCol}
                          sortDir={sortDir}
                          onSort={handleSort}
                          onCellClick={(v) => setCellInspect(v)}
                        />
                      )}
                    </div>

                    <PaginationBar
                      total={tableData.total}
                      offset={rowOffset}
                      limit={ROW_LIMIT}
                      onPrev={handlePrev}
                      onNext={handleNext}
                    />
                  </PagePanel>
                </>
              ) : null}
            </div>
          ) : (
            <div className="w-full">
              <SqlEditorPanel {...sqlEditorProps} showHistory={false} />
            </div>
          )}
        </div>
        {cellInspect !== null && (
          <CellPopover
            value={cellInspect}
            onClose={() => setCellInspect(null)}
          />
        )}
      </PageLayout>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {!showExternalSidebar && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-muted font-medium">
            {dbStatus ? (
              <>
                <span
                  className={`h-2 w-2 rounded-full ${dbStatus.connected ? "bg-ok" : "bg-danger"}`}
                />
                <span className="tracking-wide">{dbStatus.provider}</span>
              </>
            ) : (
              <span>{t("game.connecting")}</span>
            )}
          </div>

          <div className="flex-1" />

          {!showExternalSidebar && viewToggle}
        </div>
      )}

      {dbStatus && !dbStatus.connected && disconnectedState}

      {errorMessage && (
        <div className="p-3 border border-danger/50 bg-danger/20 text-danger text-sm rounded-sm mb-2 flex items-center justify-between">
          <span className="font-medium tracking-wide">{errorMessage}</span>
          <Button
            variant="ghost"
            size="icon"
            className="w-6 h-6 rounded-full text-danger hover:bg-danger/20 hover:text-danger-foreground transition-colors"
            onClick={() => setErrorMessage("")}
          >
            ×
          </Button>
        </div>
      )}

      {view === "tables" ? (
        /* ── Table Editor ──────────────────────────────────────── */
        <div className="flex flex-1 min-h-0 gap-4">
          {(showExternalSidebar || !sidebarCollapsed) && (
            <aside
              className={`flex min-h-0 w-full shrink-0 flex-col overflow-hidden ${
                showExternalSidebar
                  ? "w-[21rem] max-w-[352px] shrink-0"
                  : "w-[220px] flex-shrink-0"
              }`}
            >
              <div
                className={
                  showExternalSidebar
                    ? "flex min-h-0 flex-1 flex-col px-3 pb-4 pt-3"
                    : "p-3 flex flex-col h-full gap-3"
                }
              >
                {showExternalSidebar && (
                  <>
                    {sidebarSummary}
                    <div className="space-y-3 pt-4">
                      {viewToggle}
                      {leftNav}
                    </div>
                  </>
                )}

                {filteredCountLabel ? (
                  <div className="px-1 text-xs-tight font-medium text-muted">
                    {filteredCountLabel}
                  </div>
                ) : null}
                {loading && tables.length === 0 ? (
                  <div className="text-xs text-muted px-2 py-4 italic text-center opacity-70">
                    {t("appsview.Loading")}
                  </div>
                ) : (
                  <SidebarScrollRegion
                    className={`flex flex-col gap-1 flex-1 pr-1 ${
                      showExternalSidebar
                        ? ""
                        : "overflow-auto custom-scrollbar"
                    }`}
                  >
                    {filteredTables.map((t) => (
                      <SidebarContent.Item
                        key={t.name}
                        active={selectedTable === t.name}
                        onClick={() => handleSelectTable(t.name)}
                        className="gap-2"
                      >
                        <SidebarContent.ItemIcon
                          active={selectedTable === t.name}
                        >
                          {t.name.slice(0, 1).toUpperCase()}
                        </SidebarContent.ItemIcon>
                        <SidebarContent.ItemBody>
                          <SidebarContent.ItemTitle>
                            {t.name}
                          </SidebarContent.ItemTitle>
                          <SidebarContent.ItemDescription>
                            {(t.rowCount ?? 0).toLocaleString("en-US")} rows
                          </SidebarContent.ItemDescription>
                        </SidebarContent.ItemBody>
                      </SidebarContent.Item>
                    ))}
                  </SidebarScrollRegion>
                )}
              </div>
            </aside>
          )}

          {/* Toggle sidebar */}
          {!showExternalSidebar && (
            <Button
              variant="ghost"
              size="icon"
              className="my-auto flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-sm border border-border/40 bg-card/50 text-muted transition-all hover:border-accent/40 hover:bg-bg-hover hover:text-txt"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={
                sidebarCollapsed
                  ? t("databaseview.showSidebar", {
                      defaultValue: "Show sidebar",
                    })
                  : t("databaseview.hideSidebar", {
                      defaultValue: "Hide sidebar",
                    })
              }
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronLeft className="w-3.5 h-3.5" />
              )}
            </Button>
          )}

          {/* Main grid area */}
          <div className="flex min-w-0 flex-1 w-full flex-col bg-bg/10">
            {!selectedTable ? (
              noTableSelectedState
            ) : loading && !tableData ? (
              <PagePanel
                variant="surface"
                className="flex flex-1 items-center justify-center px-6 py-10 text-sm font-medium italic text-muted"
              >
                {t("appsview.Loading")}
              </PagePanel>
            ) : tableData ? (
              <>
                <PagePanel
                  variant="surface"
                  as="section"
                  className="px-5 py-5 sm:px-6"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-2xl font-semibold text-txt-strong">
                        {selectedTable}
                      </div>
                    </div>
                    {columnMeta.size > 0 && (
                      <div className="flex flex-wrap gap-2">
                        <MetaPill>
                          {columnMeta.size} {t("databaseview.columns")}
                        </MetaPill>
                        <MetaPill>
                          {t("databaseview.RowCountLabel", {
                            count: tableData.total.toLocaleString("en-US"),
                            defaultValue: "{{count}} rows",
                          })}
                        </MetaPill>
                      </div>
                    )}
                  </div>
                </PagePanel>

                <PagePanel
                  variant="surface"
                  className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden p-3"
                >
                  <div className="flex-1 min-h-0">
                    {tableData.rows.length === 0 ? (
                      emptyTableState
                    ) : (
                      <ResultsGrid
                        columns={tableData.columns}
                        rows={tableData.rows}
                        columnMeta={columnMeta}
                        sortCol={sortCol}
                        sortDir={sortDir}
                        onSort={handleSort}
                        onCellClick={(v) => setCellInspect(v)}
                      />
                    )}
                  </div>

                  <PaginationBar
                    total={tableData.total}
                    offset={rowOffset}
                    limit={ROW_LIMIT}
                    onPrev={handlePrev}
                    onNext={handleNext}
                  />
                </PagePanel>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        /* ── SQL Editor ────────────────────────────────────────── */
        <div className="flex flex-1 min-h-0 gap-4">
          {showExternalSidebar && (
            <aside className="w-[21rem] max-w-[352px] shrink-0 overflow-hidden flex min-h-0 w-full flex-col">
              <div className="flex min-h-0 flex-1 flex-col px-3 pb-4 pt-3">
                {sidebarSummary}
                <div className="space-y-3 pt-4">
                  {viewToggle}
                  {leftNav}
                </div>
                {queryHistory.length > 0 ? (
                  <SidebarScrollRegion className="mt-5 space-y-1.5">
                    <div className="px-1 text-xs-tight font-medium text-muted">
                      {t("databaseview.RecentQueries")}
                    </div>
                    {queryHistory.slice(0, 8).map((q) => (
                      <Button
                        variant="ghost"
                        key={q}
                        className="h-auto w-full justify-start rounded-sm px-3 py-2 text-left text-xs-tight font-mono text-muted-strong hover:text-txt"
                        onClick={() => setQueryText(q)}
                      >
                        <span className="truncate">{q}</span>
                      </Button>
                    ))}
                  </SidebarScrollRegion>
                ) : null}
              </div>
            </aside>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto flex min-h-0 flex-col gap-4 bg-transparent">
            <PagePanel
              variant="surface"
              as="section"
              className="px-5 py-5 sm:px-6"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-2xl font-semibold text-txt-strong">
                    {t("databaseview.SQLWorkspace", {
                      defaultValue: "SQL Workspace",
                    })}
                  </div>
                </div>
              </div>
            </PagePanel>

            <SqlEditorPanel
              {...sqlEditorProps}
              showHistory={!showExternalSidebar}
            />
          </div>
        </div>
      )}

      {/* Cell inspect overlay */}
      {cellInspect !== null && (
        <CellPopover value={cellInspect} onClose={() => setCellInspect(null)} />
      )}
    </div>
  );
}
