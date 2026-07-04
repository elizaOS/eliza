/**
 * Loading skeleton matching the dashboard table column layout.
 */
import type { ReactNode } from "react";
import { Skeleton } from "../../../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { cn } from "../../lib/utils";

interface DashboardTableSkeletonColumn {
  key: string;
  label: ReactNode;
  cellClassName?: string;
  skeletonClassName?: string;
}

interface DashboardTableSkeletonProps {
  columns: readonly DashboardTableSkeletonColumn[];
  rows?: number;
  className?: string;
}

export function DashboardTableSkeleton({
  columns,
  rows = 3,
  className,
}: DashboardTableSkeletonProps) {
  const rowIds = Array.from(
    { length: rows },
    (_, index) => `dashboard-table-skeleton-row-${index + 1}`,
  );

  return (
    <div className={cn("overflow-hidden rounded-sm border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.cellClassName}>
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rowIds.map((rowId) => (
            <TableRow key={rowId}>
              {columns.map((column) => (
                <TableCell key={column.key} className={column.cellClassName}>
                  <Skeleton
                    className={cn("h-4 w-24", column.skeletonClassName)}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export type { DashboardTableSkeletonColumn, DashboardTableSkeletonProps };
