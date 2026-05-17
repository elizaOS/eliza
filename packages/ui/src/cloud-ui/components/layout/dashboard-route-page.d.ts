import type { ComponentPropsWithoutRef, DependencyList, ReactNode } from "react";
import { DashboardPageContainer, DashboardPageStack } from "./dashboard-page";
type DashboardRoutePageBannerTone = "info" | "success" | "warning" | "error";
type DashboardRoutePageContainerProps = Omit<ComponentPropsWithoutRef<typeof DashboardPageContainer>, "children">;
type DashboardRoutePageStackProps = Omit<ComponentPropsWithoutRef<typeof DashboardPageStack>, "children">;
interface DashboardRoutePageProps {
    title: string;
    description?: string;
    actions?: ReactNode;
    headerDeps?: DependencyList;
    children: ReactNode;
    container?: boolean | DashboardRoutePageContainerProps;
    stack?: boolean | DashboardRoutePageStackProps;
    banner?: ReactNode;
    bannerTone?: DashboardRoutePageBannerTone;
    bannerClassName?: string;
}
export declare function DashboardRoutePage({ title, description, actions, headerDeps, children, container, stack, banner, bannerTone, bannerClassName, }: DashboardRoutePageProps): import("react/jsx-runtime").JSX.Element;
export type { DashboardRoutePageBannerTone, DashboardRoutePageContainerProps, DashboardRoutePageProps, DashboardRoutePageStackProps, };
//# sourceMappingURL=dashboard-route-page.d.ts.map