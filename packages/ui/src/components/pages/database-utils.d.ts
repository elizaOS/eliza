import type { ColumnInfo } from "../../api";
export type DbView = "tables" | "query";
export type SortDir = "asc" | "desc" | null;
/** Format a cell value for display. */
export declare function formatCell(val: unknown): string;
/** Abbreviated type label for column badges. */
export declare function typeLabel(type: string): string;
/** Color for column type badge. */
export declare function typeBadgeColor(type: string): string;
export declare function CellPopover({
  value,
  onClose,
}: {
  value: string;
  onClose: () => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function ResultsGrid({
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
}): import("react/jsx-runtime").JSX.Element;
export declare function PaginationBar({
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
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=database-utils.d.ts.map
