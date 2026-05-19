import type { ReactNode } from "react";
interface DashboardActionLinkProps {
    to: string;
    className?: string;
    children: ReactNode;
}
interface DashboardActionCardsProps {
    /** null = balance unavailable. */
    creditBalance: number | null;
    className?: string;
    renderLink?: (props: DashboardActionLinkProps) => ReactNode;
}
interface AppsEmptyStateProps {
    /** Override the default app-first messaging if needed. */
    description?: string;
    /** Optional CTA. */
    action?: ReactNode;
}
export declare function DashboardActionCards({ creditBalance, className, renderLink, }: DashboardActionCardsProps): import("react/jsx-runtime").JSX.Element;
export declare function DashboardActionCardsSkeleton(): import("react/jsx-runtime").JSX.Element;
export declare function AppsEmptyState({ description, action }: AppsEmptyStateProps): import("react/jsx-runtime").JSX.Element;
export declare function AppsSkeleton(): import("react/jsx-runtime").JSX.Element;
export declare function ContainersSkeleton(): import("react/jsx-runtime").JSX.Element;
export declare function ContainersEmptyState(): import("react/jsx-runtime").JSX.Element;
export type { AppsEmptyStateProps, DashboardActionCardsProps };
//# sourceMappingURL=cloud-dashboard-components.d.ts.map