/**
 * Canonical anatomy for ordinary framed product pages. It fixes header,
 * navigation, content-width, scrolling, and composer-clearance geometry while
 * leaving full-canvas surfaces outside this boundary.
 */
import type { HTMLAttributes, ReactNode } from "react";

import { ViewHeader } from "../../components/shared/ViewHeader";
import { cn } from "../../lib/utils";

export interface FramedPageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  reserveComposer?: boolean;
}

export function FramedPage({
  className,
  children,
  reserveComposer = true,
  ...props
}: FramedPageProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col",
        reserveComposer &&
          "pb-[var(--eliza-chat-clearance,5.25rem)] pe-[var(--eliza-chat-side-clearance,0px)]",
        className,
      )}
      data-framed-page=""
      {...props}
    >
      {children}
    </div>
  );
}

export interface FramedPageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  showBack?: boolean;
  className?: string;
}

export function FramedPageHeader({
  title,
  description,
  actions,
  onBack,
  backLabel,
  showBack,
  className,
}: FramedPageHeaderProps) {
  return (
    <div className={cn("shrink-0", className)} data-framed-page-header="">
      <ViewHeader
        title={title}
        right={actions}
        onBack={onBack}
        backLabel={backLabel}
        showBack={showBack}
      />
      {description ? (
        <div className="mx-auto w-full max-w-5xl px-4 pb-3 text-sm text-muted sm:px-6 lg:px-8">
          {description}
        </div>
      ) : null}
    </div>
  );
}

export interface FramedPageNavigationProps
  extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
}

export function FramedPageNavigation({
  children,
  className,
  padded = true,
  ...props
}: FramedPageNavigationProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-5xl min-w-0 shrink-0 pb-2",
        padded && "px-4 sm:px-6 lg:px-8",
        className,
      )}
      data-framed-page-navigation=""
      {...props}
    >
      {children}
    </div>
  );
}

export interface FramedPageBodyProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  scroll?: "page" | "view";
  padded?: boolean;
}

export function FramedPageBody({
  children,
  className,
  scroll = "page",
  padded = true,
  ...props
}: FramedPageBodyProps) {
  return (
    <div
      className={cn(
        "mx-auto flex min-h-0 w-full max-w-5xl min-w-0 flex-1 flex-col",
        padded && "px-4 sm:px-6 lg:px-8",
        scroll === "page"
          ? "eliza-chat-scroll overflow-y-auto"
          : "overflow-hidden",
        className,
      )}
      data-framed-page-body=""
      data-framed-page-scroll={scroll}
      {...props}
    >
      {children}
    </div>
  );
}
