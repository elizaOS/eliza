import type { ReactNode } from "react";
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
export declare function ResponsiveEntityList<T>({ items, getKey, columns, renderRow, renderCard, empty, desktopClassName, mobileClassName, tableHeaderClassName, }: ResponsiveEntityListProps<T>): import("react/jsx-runtime").JSX.Element;
export type { ResponsiveEntityListColumn, ResponsiveEntityListProps };
//# sourceMappingURL=responsive-entity-list.d.ts.map