/**
 * Database View — Supabase-style table browser + SQL editor.
 *
 * Two modes:
 *  - Table browser: sidebar with schema tree, spreadsheet-like data grid
 *  - SQL editor: code textarea with run button and results grid
 */

import { Badge, Button, Input, Textarea } from "@elizaos/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ColumnInfo,
  client,
  type DatabaseStatus,
  type QueryResult,
  type TableInfo,
  type TableRowsResponse,
} from "../api";
import { useApp } from "../state";

type DbView = "tables" | "query";
type SortDir = "asc" | "desc" | null;

/** Format a cell value for display. */
function formatCell(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/** Abbreviated type label for column badges. */
function typeLabel(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("int")) return "int";
  if (t.includes("serial")) return "serial";
  if (t.includes("bool")) return "bool";
  if (
    t.includes("float") ||
    t.includes("double") ||
    t.includes("numeric") ||
    t.includes("real")
  )
    return "float";
  if (t.includes("json")) return "json";
  if (t.includes("uuid")) return "uuid";
  if (t.includes("timestamp")) return "time";
  if (t.includes("date")) return "date";
  if (t.includes("text") || t.includes("char") || t.includes("varchar"))
    return "text";
  if (t.includes("vector")) return "vector";
  if (t.includes("bytea")) return "bytes";
  return type.slice(0, 6);
}

/** Color for column type badge. */
function typeBadgeColor(type: string): string {
  const t = type.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("serial") ||
    t.includes("float") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("double")
  )
    return "text-amber-400 bg-amber-400/10";
  if (t.includes("bool")) return "text-purple-400 bg-purple-400/10";
  if (t.includes("json")) return "text-orange-400 bg-orange-400/10";
  if (t.includes("uuid")) return "text-cyan-400 bg-cyan-400/10";
  if (t.includes("timestamp") || t.includes("date"))
    return "text-pink-400 bg-pink-400/10";
  if (t.includes("text") || t.includes("char"))
    return "text-green-400 bg-green-400/10";
  if (t.includes("vector")) return "text-blue-400 bg-blue-400/10";
  return "text-[var(--muted)] bg-[var(--muted)]/10";
}

// ── Cell inspect popover ──────────────────────────────────────────────

function CellPopover({
  value,
  onClose,
}: {
  value: string;
  onClose: () => void;
}) {
  const { t } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-card/60 backdrop-blur-md border border-border/40 shadow-[0_8px_30px_rgba(var(--accent),0.15)] rounded-xl p-4 max-w-[500px] max-h-[300px] overflow-auto"
      style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}
    >
      <div className="flex items-center justify-between mb-3 border-b border-border/40 pb-2">
        <span className="text-xs text-muted uppercase font-bold tracking-wider">
          {t("databaseview.CellValue")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="w-6 h-6 rounded-full hover:bg-bg-hover hover:text-txt hover:shadow-[0_0_10px_rgba(var(--accent),0.2)] transition-all"
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <pre className="text-xs text-txt font-mono whitespace-pre-wrap break-all m-0 bg-bg/40 p-3 rounded-lg border border-border/40">
        {value}
      </pre>
    </div>
  );
}

// ── Results grid (shared between table browser and SQL editor) ─────────

function ResultsGrid({
  columns,
  rows,
  columnMeta,
  sortCol,
  sortDir,
  onSort,
  onCellClick,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  columnMeta?: Map<string, ColumnInfo>;
  sortCol?: string;
  sortDir?: SortDir;
  onSort?: (col: string) => void;
  onCellClick?: (value: string) => void;
}) {
  const { t } = useApp();
  return (
    <div
      className="overflow-auto border border-border/40 bg-card/40 backdrop-blur-md rounded-2xl shadow-inner"
      style={{ maxHeight: "calc(100vh - 340px)" }}
    >
      <table className="w-full border-collapse text-[12px] font-mono">
        <thead className="sticky top-0 z-10 backdrop-blur-xl bg-bg/80 border-b border-border/40 shadow-sm">
          <tr>
            {/* Row number column */}
            <th className="w-[50px] min-w-[50px] px-3 py-2.5 text-[10px] text-muted font-medium text-right border-r border-border/40">
              #
            </th>
            {columns.map((col) => {
              const meta = columnMeta?.get(col);
              const isSorted = sortCol === col;
              return (
                <th
                  key={col}
                  className="px-4 py-2.5 text-left border-r border-border/40 whitespace-nowrap cursor-pointer select-none hover:bg-bg-hover transition-colors group"
                  onClick={() => onSort?.(col)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-txt font-semibold group-hover:text-txt transition-colors">
                      {col}
                    </span>
                    {meta && (
                      <Badge
                        variant="outline"
                        className={`text-[9px] px-1.5 py-0 border-none font-medium ${typeBadgeColor(meta.type)}`}
                      >
                        {typeLabel(meta.type)}
                      </Badge>
                    )}
                    {meta?.isPrimaryKey && (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1.5 py-0 border-none font-bold text-yellow-400 bg-yellow-400/10 shadow-[0_0_8px_rgba(250,204,21,0.2)]"
                      >
                        PK
                      </Badge>
                    )}
                    {isSorted && (
                      <span className="text-[10px] text-[var(--accent)]">
                        {sortDir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={JSON.stringify(row)}
              className="border-b border-border/20 hover:bg-accent/10 transition-colors group"
            >
              <td className="px-3 py-2 text-[10px] text-muted text-right border-r border-border/30 bg-bg/20 tabular-nums group-hover:text-txt/70 transition-colors">
                {i + 1}
              </td>
              {columns.map((col) => {
                const raw = row[col];
                const display = formatCell(raw);
                const isNull = raw === null || raw === undefined;
                const isExpandable = display.length > 40 && !!onCellClick;
                return (
                  <td
                    key={col}
                    className="px-4 py-2 border-r border-border/20 max-w-[280px] truncate cursor-default transition-colors"
                    title={display}
                    onClick={() => {
                      if (isExpandable) onCellClick(display);
                    }}
                    onKeyDown={(e) => {
                      if (!isExpandable) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onCellClick(display);
                      }
                    }}
                    role={isExpandable ? "button" : undefined}
                    tabIndex={isExpandable ? 0 : undefined}
                  >
                    {isNull ? (
                      <span className="text-[var(--muted)] italic opacity-50">
                        {t("databaseview.NULL")}
                      </span>
                    ) : (
                      <span className="text-[var(--txt)]">{display}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pagination bar ────────────────────────────────────────────────────

function PaginationBar({
  total,
  offset,
  limit,
  onPrev,
  onNext,
}: {
  total: number;
  offset: number;
  limit: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useApp();
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/40 bg-card/60 backdrop-blur-md rounded-b-2xl text-[11px] text-muted">
      <span className="font-medium">
        {total.toLocaleString()} {t("databaseview.row")}
        {total !== 1 ? "s" : ""}
        {total > 0 && ` · showing ${start}-${end}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-[1.75rem] py-1 whitespace-normal break-words text-left text-[11px] rounded-lg border-border/50 hover:border-accent hover:text-txt hover:shadow-[0_0_10px_rgba(var(--accent),0.2)] transition-all bg-bg/50 backdrop-blur-sm"
          disabled={!hasPrev}
          onClick={onPrev}
        >
          {t("databaseview.Prev")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-[1.75rem] py-1 whitespace-normal break-words text-left text-[11px] rounded-lg border-border/50 hover:border-accent hover:text-txt hover:shadow-[0_0_10px_rgba(var(--accent),0.2)] transition-all bg-bg/50 backdrop-blur-sm"
          disabled={!hasNext}
          onClick={onNext}
        >
          {t("databaseview.Next")}
        </Button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function DatabaseView() {
  const { t } = useApp();
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
      setTables(t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      // Don't show error if database is simply not connected (cloud mode, agent not running)
      if (!msg.includes("Database not available")) {
        setErrorMessage(`Failed to load tables: ${msg}`);
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
        const info = tables.find((t) => t.name === tableName);
        if (info?.columns) {
          const meta = new Map<string, ColumnInfo>();
          for (const col of info.columns) meta.set(col.name, col);
          setColumnMeta(meta);
        }
      } catch (err) {
        setErrorMessage(
          `Failed to load table: ${err instanceof Error ? err.message : "error"}`,
        );
      }
      setLoading(false);
    },
    [tables],
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
        `Query failed: ${err instanceof Error ? err.message : "error"}`,
      );
    }
    setQueryLoading(false);
  }, [queryText]);

  useEffect(() => {
    const init = async () => {
      const status = await loadStatus();
      if (status?.connected) {
        await loadTables();
      }
    };
    void init();
  }, [loadStatus, loadTables]);

  const filteredTables = tables.filter(
    (t) =>
      !sidebarSearch ||
      t.name.toLowerCase().includes(sidebarSearch.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Top bar */}
      <div className="flex items-center gap-3 p-3 bg-card/60 backdrop-blur-xl border border-border/40 rounded-2xl shadow-sm">
        <div className="flex items-center gap-2 text-xs text-muted font-medium bg-bg/50 px-3 py-1.5 rounded-lg border border-border/30">
          {dbStatus ? (
            <>
              <span
                className={`w-2 h-2 rounded-full shadow-[0_0_8px_currentColor] ${dbStatus.connected ? "text-green-400 bg-green-400" : "text-red-400 bg-red-400"}`}
              />
              <span className="tracking-wide">{dbStatus.provider}</span>
              <span className="opacity-40">·</span>
              <span>
                {dbStatus.tableCount} {t("databaseview.tables")}
              </span>
            </>
          ) : (
            <span>{t("databaseview.Connecting")}</span>
          )}
        </div>

        <div className="flex-1" />

        {/* View toggle */}
        <div className="flex p-1 bg-bg/50 backdrop-blur-md border border-border/40 rounded-xl shadow-inner gap-1">
          <Button
            variant={view === "tables" ? "default" : "ghost"}
            size="sm"
            className={`h-auto min-h-[1.75rem] px-4 py-1 whitespace-normal break-words text-left text-xs font-medium rounded-lg transition-all duration-300 ${
              view === "tables"
                ? "bg-accent text-accent-fg shadow-[0_0_15px_rgba(var(--accent),0.4)] border border-accent/50 scale-105"
                : "text-muted hover:text-txt hover:bg-bg-hover hover:border-border/50"
            }`}
            onClick={() => setView("tables")}
          >
            {t("databaseview.TableEditor")}
          </Button>
          <Button
            variant={view === "query" ? "default" : "ghost"}
            size="sm"
            className={`h-auto min-h-[1.75rem] px-4 py-1 whitespace-normal break-words text-left text-xs font-medium rounded-lg transition-all duration-300 ${
              view === "query"
                ? "bg-accent text-accent-fg shadow-[0_0_15px_rgba(var(--accent),0.4)] border border-accent/50 scale-105"
                : "text-muted hover:text-txt hover:bg-bg-hover hover:border-border/50"
            }`}
            onClick={() => setView("query")}
          >
            {t("databaseview.SQLEditor")}
          </Button>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-[2.25rem] whitespace-normal break-words px-4 py-1.5 text-xs font-medium rounded-xl border-border/50 hover:border-accent hover:text-txt transition-all duration-300 bg-bg/50 backdrop-blur-md shadow-sm hover:shadow-[0_0_15px_rgba(var(--accent),0.3)]"
          onClick={async () => {
            const status = await loadStatus();
            if (status?.connected) {
              await loadTables();
            }
          }}
        >
          {t("databaseview.Refresh")}
        </Button>
      </div>

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
          {/* Sidebar */}
          <div
            className={`flex-shrink-0 border border-border/40 bg-card/60 backdrop-blur-xl rounded-2xl transition-all overflow-hidden flex flex-col shadow-sm ${sidebarCollapsed ? "w-0 opacity-0 border-none m-0" : "w-[220px]"}`}
          >
            <div className="p-3 flex flex-col h-full gap-3">
              <div className="relative">
                <Input
                  type="text"
                  placeholder={t("databaseview.FilterTables")}
                  value={sidebarSearch}
                  onChange={(e) => setSidebarSearch(e.target.value)}
                  className="w-full h-9 rounded-xl border-border/50 bg-bg/50 backdrop-blur-sm text-xs focus-visible:ring-accent/50 focus-visible:border-accent pr-8 shadow-inner"
                />
              </div>
              <div className="text-[10px] text-muted uppercase font-bold tracking-widest px-2 bg-black/10 py-1.5 rounded-lg border border-white/5 inline-flex items-center shadow-inner">
                {t("databaseview.Tables")} ({filteredTables.length})
              </div>
              {loading && tables.length === 0 ? (
                <div className="text-xs text-muted px-2 py-4 italic text-center opacity-70">
                  {t("databaseview.Loading")}
                </div>
              ) : (
                <div className="flex flex-col gap-1 flex-1 overflow-auto pr-1 custom-scrollbar">
                  {filteredTables.map((t) => (
                    <Button
                      variant={selectedTable === t.name ? "secondary" : "ghost"}
                      key={t.name}
                      onClick={() => handleSelectTable(t.name)}
                      className={`justify-start h-8 px-3 text-xs w-full transition-all duration-300 rounded-xl ${
                        selectedTable === t.name
                          ? "bg-accent/20 text-txt font-semibold border border-accent/30 shadow-[0_0_10px_rgba(var(--accent),0.1)] translate-x-1"
                          : "text-muted hover:text-txt hover:bg-bg-hover hover:translate-x-0.5"
                      }`}
                    >
                      <span className="truncate flex-1 text-left">
                        {t.name}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1.5 py-0 h-4 border-white/10 bg-black/20 text-muted-foreground ml-2 tabular-nums"
                      >
                        {t.rowCount}
                      </Badge>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Toggle sidebar */}
          <Button
            variant="ghost"
            size="icon"
            className="flex-shrink-0 w-6 h-12 flex items-center justify-center rounded-xl bg-card/40 backdrop-blur-sm border border-border/40 my-auto shadow-sm text-muted hover:text-txt hover:bg-bg-hover hover:border-accent/40 transition-all hover:scale-110"
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

          {/* Main grid area */}
          <div className="flex-1 min-w-0 flex flex-col bg-card/40 backdrop-blur-xl border border-border/40 rounded-2xl shadow-sm overflow-hidden p-2">
            {!selectedTable ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center p-8 border border-white/5 bg-black/10 rounded-3xl shadow-inner backdrop-blur-md">
                  <div className="text-muted text-base font-medium mb-2 tracking-wide">
                    {t("databaseview.SelectATable")}
                  </div>
                  <div className="text-muted text-xs opacity-60 tracking-wider uppercase">
                    {t("databaseview.ChooseATableFrom")}
                  </div>
                </div>
              </div>
            ) : loading && !tableData ? (
              <div className="flex-1 flex items-center justify-center font-medium text-muted text-sm italic tracking-widest animate-pulse">
                {t("databaseview.Loading")}
              </div>
            ) : tableData ? (
              <>
                {/* Table header bar */}
                <div className="flex items-center gap-3 px-3 py-2 text-xs mb-2 bg-bg/40 rounded-xl border border-border/30">
                  <span className="text-txt font-semibold tracking-wide">
                    {selectedTable}
                  </span>
                  {columnMeta.size > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted border-white/10 bg-black/20 font-medium"
                    >
                      {columnMeta.size} {t("databaseview.columns")}
                    </Badge>
                  )}
                </div>

                {/* Data grid */}
                <div className="flex-1 min-h-0">
                  {tableData.rows.length === 0 ? (
                    <div className="flex items-center justify-center h-full border border-border/40 bg-card/40 rounded-t-2xl">
                      <div className="text-muted text-sm p-6 bg-black/10 rounded-2xl border border-white/5 shadow-inner backdrop-blur-md font-medium tracking-wide">
                        {t("databaseview.TableIsEmpty")}
                      </div>
                    </div>
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

                {/* Pagination */}
                <PaginationBar
                  total={tableData.total}
                  offset={rowOffset}
                  limit={ROW_LIMIT}
                  onPrev={handlePrev}
                  onNext={handleNext}
                />
              </>
            ) : null}
          </div>
        </div>
      ) : (
        /* ── SQL Editor ────────────────────────────────────────── */
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          {/* Editor area */}
          <div className="flex flex-col bg-card/60 backdrop-blur-xl border border-border/40 rounded-2xl p-4 shadow-sm">
            <div className="relative group">
              <div className="absolute -inset-[1px] bg-gradient-to-r from-accent/0 via-accent/30 to-accent/0 rounded-2xl opacity-0 group-focus-within:opacity-100 blur transition-opacity duration-500" />
              <Textarea
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    runQuery();
                  }
                }}
                placeholder={t("databaseview.SELECTFROMMemori")}
                rows={6}
                className="w-full relative bg-bg/80 backdrop-blur-md border-border/50 text-txt text-sm font-mono resize-y leading-relaxed rounded-xl focus-visible:ring-accent focus-visible:border-accent custom-scrollbar shadow-inner"
                spellCheck={false}
              />
            </div>
            <div className="flex items-center gap-3 mt-3">
              <Button
                variant="default"
                size="sm"
                className="px-6 h-auto min-h-[2.25rem] whitespace-normal break-words text-left py-1.5 text-xs font-bold rounded-xl bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40 shadow-[0_0_15px_rgba(var(--accent),0.4)] transition-all hover:scale-[1.02]"
                disabled={queryLoading || !queryText.trim()}
                onClick={runQuery}
              >
                {queryLoading
                  ? t("common.running", { defaultValue: "Running..." })
                  : t("databaseview.runQuery", { defaultValue: "Run Query" })}
              </Button>
              <kbd className="text-[10px] text-muted font-mono bg-bg/50 px-2 py-1 rounded-md border border-border/30 shadow-inner tracking-wider">
                {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}{" "}
                {t("databaseview.Enter")}
              </kbd>
              {queryResult && (
                <div className="text-xs text-muted ml-auto bg-black/10 px-3 py-1.5 rounded-lg border border-white/5 font-medium shadow-inner tracking-wide">
                  <span className="text-txt">{queryResult.rowCount}</span>{" "}
                  {t("databaseview.row")}
                  {queryResult.rowCount !== 1 ? "s" : ""} ·{" "}
                  <span className="text-txt">{queryResult.durationMs}ms</span>
                </div>
              )}
            </div>
          </div>

          {/* Query history dropdown */}
          {queryHistory.length > 0 && !queryResult && (
            <div className="border border-border/40 bg-card/40 backdrop-blur-xl rounded-2xl shadow-sm overflow-hidden">
              <div className="px-4 py-2.5 text-[10px] text-muted uppercase font-bold tracking-widest bg-bg/60 border-b border-border/40 shadow-inner">
                {t("databaseview.RecentQueries")}
              </div>
              <div className="flex flex-col">
                {queryHistory.slice(0, 5).map((q) => (
                  <Button
                    variant="ghost"
                    key={q}
                    className="w-full px-4 py-3 h-auto justify-start text-[11px] font-mono text-txt text-left rounded-none border-b border-border/20 hover:bg-accent/10 hover:text-txt transition-colors truncate"
                    onClick={() => setQueryText(q)}
                  >
                    <span className="truncate opacity-80 group-hover:opacity-100">
                      {q}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Results */}
          {queryResult && queryResult.rows.length > 0 && (
            <div className="flex-1 min-h-0">
              <ResultsGrid
                columns={queryResult.columns}
                rows={queryResult.rows}
                onCellClick={(v) => setCellInspect(v)}
              />
            </div>
          )}

          {queryResult && queryResult.rows.length === 0 && (
            <div className="flex items-center justify-center p-8 border border-border/40 bg-card/60 backdrop-blur-xl rounded-2xl shadow-sm text-muted text-sm tracking-wide font-medium">
              <div className="px-6 py-4 bg-black/10 shadow-inner rounded-xl border border-white/5">
                {t("databaseview.QueryReturnedNoRo")}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Cell inspect overlay */}
      {cellInspect !== null && (
        <CellPopover value={cellInspect} onClose={() => setCellInspect(null)} />
      )}
    </div>
  );
}
