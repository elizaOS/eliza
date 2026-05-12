import {
  Button,
  Input,
  MetaPill,
  PageLayout,
  PagePanel,
  SegmentedControl,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ColumnInfo,
  client,
  type DatabaseStatus,
  type QueryResult,
  type TableInfo,
  type TableRowsResponse,
} from "../../api";
import { useApp } from "../../state";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import {
  CellPopover,
  type DbView,
  PaginationBar,
  ResultsGrid,
  type SortDir,
} from "./database-utils";
import { SqlEditorPanel } from "./SqlEditorPanel";

export function DatabaseView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  const { t } = useApp();
  const showExternalSidebar = Boolean(leftNav);
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
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

  // SQL editor state
  const [queryText, setQueryText] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);

  const ROW_LIMIT = 50;

  const loadStatus = useCallback(async (): Promise<DatabaseStatus | null> => {
    try {
      const status = await client.getDatabaseStatus();
      setDbStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  const loadTables = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const { tables: t } = await client.getDatabaseTables();
      setTables(Array.isArray(t) ? t : []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      // Don't show error if database is simply not connected (cloud mode, agent not running)
      if (!msg.includes("Database not available")) {
        setErrorMessage(
          t("databaseview.FailedToLoadTables", {
            message: msg,
            defaultValue: "Failed to load tables: {{message}}",
          }),
        );
      }
    }
    setLoading(false);
  }, [t]);

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
        const info = tables.find((t) => t.name === tableName);
        if (info?.columns) {
          const meta = new Map<string, ColumnInfo>();
          for (const col of info.columns) meta.set(col.name, col);
          setColumnMeta(meta);
        }
      } catch (err) {
        setErrorMessage(
          t("databaseview.FailedToLoadTable", {
            message: err instanceof Error ? err.message : "error",
            defaultValue: "Failed to load table: {{message}}",
          }),
        );
      }
      setLoading(false);
    },
    [t, tables],
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

  const viewToggle = (
    <SegmentedControl
      value={view}
      onValueChange={(v) => setView(v)}
      items={[
        { value: "tables" as const, label: t("databaseview.TableEditor") },
        { value: "query" as const, label: t("databaseview.SQLEditor") },
      ]}
      aria-label={t("databaseview.EditorModes", {
        defaultValue: "Database editor modes",
      })}
      buttonClassName="h-10 flex-1"
    />
  );

  const sidebarSummary = (
    <PagePanel.SummaryCard className="mt-4">
      <div className="flex items-center gap-2 text-sm font-medium text-txt">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            dbStatus?.connected
              ? "bg-ok shadow-[0_0_8px_rgba(34,197,94,0.5)]"
              : "bg-danger"
          }`}
        />
        <span>{dbStatus?.provider ?? t("game.connecting")}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted/75">
        <MetaPill>
          {tables.length} {t("databaseview.tables")}
        </MetaPill>
        <MetaPill>
          {view === "tables"
            ? t("databaseview.TableEditor")
            : t("databaseview.SQLEditor")}
        </MetaPill>
        {selectedTable ? (
          <span className="rounded-full border border-accent/25 bg-accent/8 px-2.5 py-1 text-accent">
            {selectedTable}
          </span>
        ) : null}
      </div>
    </PagePanel.SummaryCard>
  );

  const refreshButton = (
    <Button
      variant="outline"
      size="sm"
      className="h-10 w-full justify-start rounded-2xl px-4 text-xs font-semibold border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
      onClick={async () => {
        const status = await loadStatus();
        if (status?.connected) {
          await loadTables();
        }
      }}
    >
      {t("common.refresh")}
    </Button>
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
        <SidebarHeader
          search={{
            value: sidebarSearch,
            onChange: (e) => setSidebarSearch(e.target.value),
            placeholder: t("databaseview.FilterTables"),
            "aria-label": t("databaseview.FilterTables"),
            onClear: () => setSidebarSearch(""),
          }}
        />
        <SidebarPanel>
          <div className="space-y-3 pt-1">
            {leftNav}
            {viewToggle}
            {sidebarSummary}
            {refreshButton}
          </div>

          <div className="mt-4 h-px bg-border/30" />

          {view === "tables" ? (
            <>
              <div className="space-y-3 pt-4">
                <div className="text-2xs text-muted uppercase font-bold tracking-widest px-2 bg-bg/50 py-1.5 rounded-lg border border-border/30 inline-flex items-center shadow-inner">
                  {t("databaseview.Tables")} ({filteredTables.length})
                </div>
              </div>

              <SidebarScrollRegion className="mt-3 space-y-1.5">
                {loading && tables.length === 0 ? (
                  <PagePanel
                    variant="inset"
                    className="rounded-2xl px-3 py-4 text-center text-xs text-muted"
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
                            count: (table.rowCount ?? 0).toLocaleString(),
                            defaultValue: "{{count}} rows",
                          })}
                        </SidebarContent.ItemDescription>
                      </SidebarContent.ItemBody>
                    </SidebarContent.Item>
                  ))
                )}
              </SidebarScrollRegion>
            </>
          ) : (
            <>
              <div className="space-y-3 pt-4">
                <PagePanel
                  variant="inset"
                  className="rounded-2xl px-3 py-3 text-xs-tight text-muted"
                >
                  {t("databaseview.QueryWorkspaceInfo", {
                    defaultValue:
                      "Write ad-hoc queries and inspect results without leaving the database workspace.",
                  })}
                </PagePanel>
              </div>

              {queryHistory.length > 0 ? (
                <SidebarScrollRegion className="mt-3 space-y-1.5">
                  <div className="text-2xs text-muted uppercase tracking-[0.16em]">
                    {t("databaseview.RecentQueries")}
                  </div>
                  {queryHistory.slice(0, 8).map((q) => (
                    <Button
                      variant="ghost"
                      key={q}
                      className="h-auto w-full justify-start rounded-2xl px-3 py-2 text-left text-xs-tight font-mono border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
                      onClick={() => setQueryText(q)}
                    >
                      <span className="truncate">{q}</span>
                    </Button>
                  ))}
                </SidebarScrollRegion>
              ) : null}
            </>
          )}
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
            <div className="mb-4 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
              {errorMessage}
            </div>
          ) : null}

          {dbStatus && !dbStatus.connected ? (
            <div className="w-full">
              <PagePanel
                variant="surface"
                as="section"
                className="px-5 py-5 sm:px-6"
              >
                <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                  {t("common.database")}
                </div>
                <h1 className="mt-1 text-2xl font-semibold text-txt-strong">
                  {t("databaseview.TableBrowser")}
                </h1>
              </PagePanel>

              <PagePanel.Empty
                variant="surface"
                className="mt-4 min-h-[18rem] rounded-3xl px-5 py-10"
                title={t("databaseview.DatabaseNotAvailab")}
                description={t("databaseview.TheDatabaseViewer")}
              />
            </div>
          ) : view === "tables" ? (
            <div className="w-full">
              {!selectedTable ? (
                <>
                  <PagePanel
                    variant="surface"
                    as="section"
                    className="px-5 py-5 sm:px-6"
                  >
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                      {t("common.database")}
                    </div>
                    <h1 className="mt-1 text-2xl font-semibold text-txt-strong">
                      {t("databaseview.TableBrowser")}
                    </h1>
                  </PagePanel>

                  <PagePanel.Empty
                    variant="surface"
                    className="mt-4 min-h-[18rem] rounded-3xl px-5 py-10"
                    title={t("databaseview.SelectATable")}
                    description={t("databaseview.ChooseATableFrom")}
                  />
                </>
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
                        <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                          {t("common.database")}
                        </div>
                        <h1 className="mt-1 text-2xl font-semibold text-txt-strong">
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
                          {tableData.total.toLocaleString()} {t("common.rows")}
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
                        <PagePanel.Empty
                          className="min-h-[14rem]"
                          title={t("databaseview.TableIsEmpty")}
                          description={t("databaseview.EmptyTableDescription")}
                        />
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
        <div className="flex items-center gap-3 p-3 bg-card/60 backdrop-blur-xl border border-border/40 rounded-2xl shadow-sm flex-wrap">
          <div className="flex items-center gap-2 text-xs text-muted font-medium bg-bg/50 px-3 py-1.5 rounded-lg border border-border/30">
            {dbStatus ? (
              <>
                <span
                  className={`h-2 w-2 rounded-full shadow-[0_0_8px_currentColor] ${dbStatus.connected ? "bg-ok text-ok" : "bg-danger text-danger"}`}
                />
                <span className="tracking-wide">{dbStatus.provider}</span>
                <span className="opacity-40">·</span>
                <span>
                  {dbStatus.tableCount} {t("databaseview.tables")}
                </span>
              </>
            ) : (
              <span>{t("game.connecting")}</span>
            )}
          </div>

          <div className="flex-1" />

          {!showExternalSidebar && viewToggle}

          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-[2.25rem] whitespace-normal break-words rounded-xl border-border/50 bg-bg/50 px-4 py-1.5 text-xs font-medium backdrop-blur-md shadow-sm transition-[border-color,color,transform,box-shadow] duration-300 hover:border-accent hover:text-txt hover:shadow-[0_0_15px_rgba(var(--accent-rgb),0.3)]"
            onClick={async () => {
              const status = await loadStatus();
              if (status?.connected) {
                await loadTables();
              }
            }}
          >
            {t("common.refresh")}
          </Button>
        </div>
      )}

      {dbStatus && !dbStatus.connected && (
        <div className="p-4 border border-border/40 bg-card/60 backdrop-blur-md rounded-2xl text-muted text-sm shadow-sm">
          <p className="m-0 mb-2 font-medium text-txt tracking-wide">
            {t("databaseview.DatabaseNotAvailab")}
          </p>
          <p className="m-0 text-xs">{t("databaseview.TheDatabaseViewer")}</p>
        </div>
      )}

      {errorMessage && (
        <div className="p-3 border border-danger/50 bg-danger/10 text-danger text-sm rounded-xl mb-2 flex items-center justify-between shadow-[0_0_15px_rgba(231,76,60,0.15)] backdrop-blur-md">
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
              className={`overflow-hidden rounded-2xl border shadow-sm flex min-h-0 w-full shrink-0 flex-col overflow-hidden bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_76%,transparent),color-mix(in_srgb,var(--bg-muted)_97%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_-1px_0_0_rgba(255,255,255,0.03)] backdrop-blur-md dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_-1px_0_0_rgba(255,255,255,0.02)] ${
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-10 w-full justify-start rounded-xl px-4 text-xs font-semibold shadow-sm"
                        onClick={async () => {
                          const status = await loadStatus();
                          if (status?.connected) {
                            await loadTables();
                          }
                        }}
                      >
                        {t("common.refresh")}
                      </Button>
                    </div>
                    <div className="h-px bg-border/30" />
                  </>
                )}

                <div className="relative">
                  <Input
                    type="text"
                    placeholder={t("databaseview.FilterTables")}
                    value={sidebarSearch}
                    onChange={(e) => setSidebarSearch(e.target.value)}
                    className="w-full pr-8 text-xs h-10 rounded-xl border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_14px_20px_-20px_rgba(15,23,42,0.12)] focus-visible:border-accent/28 focus-visible:ring-1 focus-visible:ring-accent/24 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_22px_-20px_rgba(0,0,0,0.22)]"
                  />
                </div>
                <div className="text-2xs text-muted uppercase font-bold tracking-widest px-2 bg-bg/50 py-1.5 rounded-lg border border-border/30 inline-flex items-center shadow-inner">
                  {t("databaseview.Tables")} ({filteredTables.length})
                </div>
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
                            {(t.rowCount ?? 0).toLocaleString()} rows
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
              className="my-auto flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-border/40 bg-card/50 shadow-sm text-muted transition-all hover:border-accent/40 hover:bg-bg-hover hover:text-txt"
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
              <div className="w-full">
                <PagePanel
                  variant="surface"
                  as="section"
                  className="px-5 py-5 sm:px-6"
                >
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                    {t("common.database")}
                  </div>
                  <div className="mt-1 text-2xl font-semibold text-txt-strong">
                    {t("databaseview.TableBrowser")}
                  </div>
                </PagePanel>

                <PagePanel.Empty
                  variant="surface"
                  className="mt-4 min-h-[18rem] rounded-3xl px-5 py-10"
                  title={t("databaseview.SelectATable")}
                  description={t("databaseview.ChooseATableFrom")}
                />
              </div>
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
                      <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                        {t("common.database")}
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-txt-strong">
                        {selectedTable}
                      </div>
                      <div className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
                        {t("databaseview.TableWorkspaceDescription", {
                          defaultValue:
                            "Inspect rows, sort columns, and review table structure in one place.",
                        })}
                      </div>
                    </div>
                    {columnMeta.size > 0 && (
                      <div className="flex flex-wrap gap-2">
                        <MetaPill>
                          {columnMeta.size} {t("databaseview.columns")}
                        </MetaPill>
                        <MetaPill>
                          {t("databaseview.RowCountLabel", {
                            count: tableData.total.toLocaleString(),
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
                      <PagePanel.Empty
                        className="min-h-[14rem]"
                        title={t("databaseview.TableIsEmpty")}
                        description={t("databaseview.EmptyTableDescription", {
                          defaultValue:
                            "This table is connected and available, but it does not have any rows yet.",
                        })}
                      />
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
            <aside className="w-[21rem] max-w-[352px] shrink-0 overflow-hidden rounded-3xl border border-border/34 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_20px_30px_-28px_rgba(15,23,42,0.18)] flex min-h-0 w-full flex-col bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_76%,transparent),color-mix(in_srgb,var(--bg-muted)_97%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_-1px_0_0_rgba(255,255,255,0.03)] backdrop-blur-md dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_-1px_0_0_rgba(255,255,255,0.02)]">
              <div className="flex min-h-0 flex-1 flex-col px-3 pb-4 pt-3">
                {sidebarSummary}
                <div className="space-y-3 pt-4">
                  {viewToggle}
                  {leftNav}
                  {refreshButton}
                </div>
                <div className="h-px bg-border/30" />
                <PagePanel
                  variant="inset"
                  className="rounded-2xl px-3 py-3 text-xs-tight text-muted"
                >
                  {t("databaseview.QueryWorkspaceInfo", {
                    defaultValue:
                      "Write ad-hoc queries and inspect results without leaving the database workspace.",
                  })}
                </PagePanel>
                {queryHistory.length > 0 ? (
                  <SidebarScrollRegion className="space-y-1.5">
                    <div className="text-2xs text-muted uppercase tracking-[0.16em]">
                      {t("databaseview.RecentQueries")}
                    </div>
                    {queryHistory.slice(0, 8).map((q) => (
                      <Button
                        variant="ghost"
                        key={q}
                        className="h-auto w-full justify-start rounded-2xl px-3 py-2 text-left text-xs-tight font-mono border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
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
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                    {t("common.database")}
                  </div>
                  <div className="mt-1 text-2xl font-semibold text-txt-strong">
                    {t("databaseview.SQLWorkspace", {
                      defaultValue: "SQL Workspace",
                    })}
                  </div>
                  <div className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
                    {t("databaseview.SQLWorkspaceDescription", {
                      defaultValue:
                        "Run ad-hoc queries, inspect results, and reuse recent SQL from the sidebar.",
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
