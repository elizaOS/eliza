import { Badge, Button } from "@elizaos/ui";
import { useEffect, useRef } from "react";
import type { ColumnInfo } from "../../api";
import { useApp } from "../../state";

export type DbView = "tables" | "query";
export type SortDir = "asc" | "desc" | null;

/** Format a cell value for display. */
export function formatCell(val: unknown): string {
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
export function typeLabel(type: string): string {
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
export function typeBadgeColor(type: string): string {
  const t = type.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("serial") ||
    t.includes("float") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("double")
  )
    return "text-accent-fg bg-accent/12";
  if (t.includes("bool")) return "text-ok bg-ok/10";
  if (t.includes("json")) return "text-warn bg-warn/10";
  if (t.includes("uuid")) return "text-accent bg-accent/10";
  if (t.includes("timestamp") || t.includes("date"))
    return "text-danger bg-danger/10";
  if (t.includes("text") || t.includes("char"))
    return "text-muted-strong bg-bg-hover";
  if (t.includes("vector")) return "text-accent bg-accent/12";
  return "text-muted-strong bg-bg-hover";
}

// ── Shared display components ─────────────────────────────────────────

export function CellPopover({
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
      className="fixed z-50 bg-card/60 backdrop-blur-md border border-border/40 shadow-[0_8px_30px_rgba(var(--accent-rgb),0.15)] rounded-xl p-4 max-w-[500px] max-h-[300px] overflow-auto"
      style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}
    >
      <div className="flex items-center justify-between mb-3 pb-2">
        <span className="text-xs text-muted uppercase font-bold tracking-wider">
          {t("databaseview.CellValue")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="w-6 h-6 rounded-full transition-[background-color,color,box-shadow] hover:bg-bg-hover hover:text-txt hover:shadow-[0_0_10px_rgba(var(--accent-rgb),0.2)]"
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

export function ResultsGrid({
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
      <table className="w-full border-collapse text-xs font-mono">
        <thead className="sticky top-0 z-10 backdrop-blur-xl bg-bg/80 border-b border-border/40 shadow-sm">
          <tr>
            {/* Row number column */}
            <th className="w-[50px] min-w-[50px] px-3 py-2.5 text-2xs text-muted font-medium text-right border-r border-border/40">
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
                    <span className="text-xs-tight text-txt font-semibold group-hover:text-txt transition-colors">
                      {col}
                    </span>
                    {meta && (
                      <Badge
                        variant="outline"
                        className={`text-3xs px-1.5 py-0 border-none font-medium ${typeBadgeColor(meta.type)}`}
                      >
                        {typeLabel(meta.type)}
                      </Badge>
                    )}
                    {meta?.isPrimaryKey && (
                      <Badge
                        variant="outline"
                        className="border-none bg-accent/16 px-1.5 py-0 text-3xs font-bold text-accent-fg shadow-sm"
                      >
                        PK
                      </Badge>
                    )}
                    {isSorted && (
                      <span className="text-2xs text-accent">
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
              <td className="px-3 py-2 text-2xs text-muted text-right border-r border-border/30 bg-bg/20 tabular-nums group-hover:text-txt/70 transition-colors">
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
                      <span className="text-muted italic opacity-50">
                        {t("databaseview.NULL")}
                      </span>
                    ) : (
                      <span className="text-txt">{display}</span>
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

export function PaginationBar({
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
    <div className="flex items-center justify-between px-4 py-2.5 bg-card/60 backdrop-blur-md rounded-b-2xl text-xs-tight text-muted">
      <span className="font-medium">
        {t("databaseview.RowCountSummary", {
          count: total.toLocaleString(),
          rowLabel:
            total === 1
              ? t("databaseview.row")
              : t("common.rows", { defaultValue: "rows" }),
          range:
            total > 0
              ? t("databaseview.ShowingRange", {
                  start,
                  end,
                  defaultValue: " · showing {{start}}-{{end}}",
                })
              : "",
          defaultValue: "{{count}} {{rowLabel}}{{range}}",
        })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-[1.75rem] whitespace-normal break-words rounded-lg border-border/50 bg-bg/50 py-1 text-left text-xs-tight backdrop-blur-sm transition-[border-color,color,box-shadow] hover:border-accent hover:text-txt hover:shadow-[0_0_10px_rgba(var(--accent-rgb),0.2)]"
          disabled={!hasPrev}
          onClick={onPrev}
        >
          {t("common.prev")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-[1.75rem] whitespace-normal break-words rounded-lg border-border/50 bg-bg/50 py-1 text-left text-xs-tight backdrop-blur-sm transition-[border-color,color,box-shadow] hover:border-accent hover:text-txt hover:shadow-[0_0_10px_rgba(var(--accent-rgb),0.2)]"
          disabled={!hasNext}
          onClick={onNext}
        >
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}
