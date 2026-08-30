/**
 * Presentational building blocks for `DatabaseView`: the results grid, a cell
 * value popover, the pagination bar, and the shared `DbView`/`SortDir` types.
 * These render query/table results the view fetches; they hold no data of their
 * own.
 */
import type { ColumnInfo } from "../../api";
import { useAppSelector } from "../../state";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CodeBlock } from "../ui/code-block";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

export type DbView = "tables" | "query";
export type SortDir = "asc" | "desc" | null;

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

/** Semantic tone for column type badges. */
function typeBadgeTone(
  type: string,
): "accent" | "success" | "warning" | "danger" | "muted" {
  const t = type.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("serial") ||
    t.includes("float") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("double")
  )
    return "accent";
  if (t.includes("bool")) return "success";
  if (t.includes("json")) return "warning";
  if (t.includes("uuid")) return "accent";
  if (t.includes("timestamp") || t.includes("date")) return "danger";
  if (t.includes("text") || t.includes("char")) return "muted";
  if (t.includes("vector")) return "accent";
  return "muted";
}

// ── Shared display components ─────────────────────────────────────────

export function CellPopover({
  value,
  onClose,
}: {
  value: string;
  onClose: () => void;
}) {
  const t = useAppSelector((s) => s.t);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-xs uppercase tracking-wider text-muted">
            {t("databaseview.CellValue")}
          </DialogTitle>
        </DialogHeader>
        <CodeBlock value={value} wrap copyable className="max-h-[300px]" />
      </DialogContent>
    </Dialog>
  );
}

export function buildResultsGridRowKey(
  columns: string[],
  row: Record<string, unknown>,
  rowIndex: number,
  columnMeta?: Map<string, ColumnInfo>,
): string | number {
  const primaryKeyCols = columns.filter(
    (col) => columnMeta?.get(col)?.isPrimaryKey,
  );
  if (!primaryKeyCols.length) return rowIndex;

  const values = primaryKeyCols.map((col) => row[col]);
  if (values.some((value) => value === null || value === undefined)) {
    return rowIndex;
  }
  return values.map((value) => `${typeof value}:${String(value)}`).join("|");
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
  const t = useAppSelector((s) => s.t);
  return (
    <TableFrame style={{ maxHeight: "calc(100vh - 340px)" }}>
      <Table density="compact" className="font-mono">
        <TableHeader variant="sticky">
          <TableRow>
            {/* Row number column */}
            <TableHead
              divider="subtle"
              className="w-[50px] min-w-[50px] px-3 py-2.5 text-2xs text-muted font-medium text-right"
            >
              #
            </TableHead>
            {columns.map((col) => {
              const meta = columnMeta?.get(col);
              const isSorted = sortCol === col;
              return (
                <TableHead
                  key={col}
                  divider="subtle"
                  interactive
                  className="px-4 py-2.5 text-left whitespace-nowrap select-none group"
                  onClick={() => onSort?.(col)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs-tight text-txt font-semibold group-hover:text-txt transition-colors">
                      {col}
                    </span>
                    {meta && (
                      <Badge
                        variant="outline"
                        size="micro"
                        tone={typeBadgeTone(meta.type)}
                      >
                        {typeLabel(meta.type)}
                      </Badge>
                    )}
                    {meta?.isPrimaryKey && (
                      <Badge variant="outline" size="microBold" tone="accent">
                        PK
                      </Badge>
                    )}
                    {isSorted && (
                      <span className="text-2xs text-accent">
                        {sortDir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </div>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => {
            const rowKey = buildResultsGridRowKey(columns, row, i, columnMeta);
            return (
              <TableRow key={rowKey} variant="subtle" className="group">
                <TableCell
                  variant="rowNumber"
                  className="px-3 py-2 text-2xs text-muted text-right tabular-nums group-hover:text-txt/70 transition-colors"
                >
                  {i + 1}
                </TableCell>
                {columns.map((col) => {
                  const raw = row[col];
                  const display = formatCell(raw);
                  const isNull = raw === null || raw === undefined;
                  const isExpandable = display.length > 40 && !!onCellClick;
                  return (
                    <TableCell
                      key={col}
                      variant="divided"
                      className="px-4 py-2 max-w-[280px] truncate cursor-default transition-colors"
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
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableFrame>
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
  const t = useAppSelector((s) => s.t);
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-card/95 rounded-b-2xl text-xs-tight text-muted">
      <span className="font-medium">
        {t("databaseview.RowCountSummary", {
          count: total.toLocaleString("en-US"),
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
          variant="outlineMuted"
          size="tinyWide"
          align="start"
          className="whitespace-normal break-words"
          disabled={!hasPrev}
          onClick={onPrev}
        >
          {t("common.prev")}
        </Button>
        <Button
          variant="outlineMuted"
          size="tinyWide"
          align="start"
          className="whitespace-normal break-words"
          disabled={!hasNext}
          onClick={onNext}
        >
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}
