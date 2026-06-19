"use client";

import type {
  ComponentPropsWithoutRef,
  DependencyList,
  ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { DashboardPageContainer, DashboardPageStack } from "./dashboard-page";
import { useSetPageHeader } from "./page-header-context.hooks";

type DashboardRoutePageBannerTone = "info" | "success" | "warning" | "error";

type DashboardRoutePageContainerProps = Omit<
  ComponentPropsWithoutRef<typeof DashboardPageContainer>,
  "children"
>;

type DashboardRoutePageStackProps = Omit<
  ComponentPropsWithoutRef<typeof DashboardPageStack>,
  "children"
>;

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

const bannerTones: Record<DashboardRoutePageBannerTone, string> = {
  info: "border-blue-400/30 bg-blue-400/10 text-blue-100",
  success: "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-100",
  error: "border-red-500/40 bg-red-500/10 text-red-400",
};

function normalizeLayoutProps<T extends object>(
  value: boolean | T | undefined,
): T | null {
  if (!value) return null;
  if (value === true) return {} as T;
  return value;
}

export function DashboardRoutePage({
  title,
  description,
  actions,
  headerDeps = [],
  children,
  container,
  stack,
  banner,
  bannerTone = "info",
  bannerClassName,
}: DashboardRoutePageProps) {
  useSetPageHeader({ title, description, actions }, headerDeps);

  const stackProps = normalizeLayoutProps<DashboardRoutePageStackProps>(stack);
  const containerProps =
    normalizeLayoutProps<DashboardRoutePageContainerProps>(container);

  let content = (
    <>
      {banner ? (
        <div
          className={cn(
            "mb-4 border px-4 py-3 text-sm",
            bannerTones[bannerTone],
            bannerClassName,
          )}
        >
          {banner}
        </div>
      ) : null}
      {children}
    </>
  );

  if (stackProps) {
    content = (
      <DashboardPageStack {...stackProps}>{content}</DashboardPageStack>
    );
  }

  if (containerProps) {
    content = (
      <DashboardPageContainer {...containerProps}>
        {content}
      </DashboardPageContainer>
    );
  }

  return content;
}

export type {
  DashboardRoutePageBannerTone,
  DashboardRoutePageContainerProps,
  DashboardRoutePageProps,
  DashboardRoutePageStackProps,
};
