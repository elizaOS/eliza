import type { ComponentType, ReactNode } from "react";
interface DataListEmptyStateProps {
    title: ReactNode;
    description?: ReactNode;
    icon?: ComponentType<{
        className?: string;
    }>;
    action?: ReactNode;
    className?: string;
    iconClassName?: string;
}
export declare function DataListEmptyState({ title, description, icon: Icon, action, className, iconClassName, }: DataListEmptyStateProps): import("react/jsx-runtime").JSX.Element;
export type { DataListEmptyStateProps };
//# sourceMappingURL=data-list-empty-state.d.ts.map