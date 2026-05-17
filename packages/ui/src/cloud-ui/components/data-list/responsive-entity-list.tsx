import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "../table";
import {
  DashboardDataListCard,
  DashboardDataListDesktop,
  DashboardDataListMobile,
} from "./dashboard-data-list";

interface ResponsiveEntityListColumn {
  key: string;
  label: ReactNode;
  className?: string;
}

interface ResponsiveEntityListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  columns: readonly ResponsiveEntityListColumn[];
  renderRow: (item: T) => ReactNode;
  renderCard: (item: T) => ReactNode;
  empty?: ReactNode;
  desktopClassName?: string;
  mobileClassName?: string;
  tableHeaderClassName?: string;
}

export function ResponsiveEntityList<T>({
  items,
  getKey,
  columns,
  renderRow,
  renderCard,
  empty,
  desktopClassName,
  mobileClassName,
  tableHeaderClassName,
}: ResponsiveEntityListProps<T>) {
  if (items.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <>
      <DashboardDataListDesktop className={desktopClassName}>
        <Table>
          <TableHeader>
            <TableRow
              className={cn(
                "border-b border-white/10 bg-black/40 hover:bg-black/40",
                tableHeaderClassName,
              )}
            >
              {columns.map((column) => (
                <TableHead key={column.key} className={column.className}>
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>{items.map((item) => renderRow(item))}</TableBody>
        </Table>
      </DashboardDataListDesktop>

      <DashboardDataListMobile className={mobileClassName}>
        {items.map((item) => (
          <DashboardDataListCard key={getKey(item)}>
            {renderCard(item)}
          </DashboardDataListCard>
        ))}
      </DashboardDataListMobile>
    </>
  );
}

export type { ResponsiveEntityListColumn, ResponsiveEntityListProps };
