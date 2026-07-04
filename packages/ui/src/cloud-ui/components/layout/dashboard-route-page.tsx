"use client";

/**
 * A dashboard route page that wires its header into the page-header context.
 */
import type {
  ComponentPropsWithoutRef,
  DependencyList,
  ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { DashboardPageContainer, DashboardPageStack } from "./dashboard-page";
import { EnsurePageHeaderProvider } from "./page-header-context";
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
  // Brand rule: no blue. Slate reads as neutral "info" alongside the
  // emerald/amber/red tones below.
  info: "border-slate-400/30 bg-slate-400/10 text-slate-100",
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

/**
 * A dashboard route body. Publishes its title/description/actions to the page
 * header context and renders the standard container/stack/banner layout.
 *
 * Self-sufficient w.r.t. the page header context: dashboard routes are mounted
 * standalone by `CloudRouterShell` — and natively inside the app — with no
 * ancestor `PageHeaderProvider`, which would make {@link useSetPageHeader}
 * throw. When no provider is present this component supplies its own; when a
 * host already provides one (e.g. a dashboard shell that renders the header
 * chrome), it defers to that provider so the header stays visible to the chrome.
 */
export function DashboardRoutePage(props: DashboardRoutePageProps) {
  return (
    <EnsurePageHeaderProvider>
      <DashboardRoutePageBody {...props} />
    </EnsurePageHeaderProvider>
  );
}

function DashboardRoutePageBody({
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
