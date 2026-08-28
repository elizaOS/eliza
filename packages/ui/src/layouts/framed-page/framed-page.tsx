/**
 * Canonical inner anatomy for ordinary framed product pages. PageFrame owns
 * the single outer width and gutter; this layer aligns header, navigation, and
 * body to that inherited edge while owning view scrolling and composer
 * clearance. Full-canvas surfaces stay outside this boundary.
 */
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
} from "react";

import { ViewHeader } from "../../components/shared/ViewHeader";
import { cn } from "../../lib/utils";

export interface FramedPageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Names the one layer responsible for the route's outer X-axis gutter. */
  gutterOwner: "page-frame" | "framed-page";
  reserveComposer?: boolean;
}

const FramedPageGutterOwnerContext = createContext<
  FramedPageProps["gutterOwner"] | null
>(null);

function useFramedPageGutterOwner(): FramedPageProps["gutterOwner"] {
  const owner = useContext(FramedPageGutterOwnerContext);
  if (owner === null) {
    throw new Error("Framed page regions must be nested inside FramedPage");
  }
  return owner;
}

export function FramedPage({
  className,
  children,
  gutterOwner,
  reserveComposer = true,
  ...props
}: FramedPageProps) {
  return (
    <FramedPageGutterOwnerContext.Provider value={gutterOwner}>
      <div
        className={cn(
          "flex h-full min-h-0 w-full min-w-0 flex-col",
          reserveComposer && "pb-[var(--eliza-chat-clearance,5.25rem)]",
          className,
        )}
        data-framed-page=""
        data-framed-page-gutter-owner={gutterOwner}
        {...props}
      >
        {children}
      </div>
    </FramedPageGutterOwnerContext.Provider>
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
  const gutterOwner = useFramedPageGutterOwner();
  const inheritsPageFrameGutter = gutterOwner === "page-frame";
  return (
    <div className={cn("shrink-0", className)} data-framed-page-header="">
      <ViewHeader
        className={inheritsPageFrameGutter ? "px-0 sm:px-0" : undefined}
        title={title}
        right={actions}
        onBack={onBack}
        backLabel={backLabel}
        showBack={showBack}
      />
      {description ? (
        <div
          className={cn(
            "mx-auto w-full max-w-5xl pb-3 text-sm text-muted",
            !inheritsPageFrameGutter && "px-4 sm:px-6 lg:px-8",
          )}
        >
          {description}
        </div>
      ) : null}
    </div>
  );
}

export interface FramedPageNavigationProps
  extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Adds a local inset only for deliberately nested navigation regions. */
  padded?: boolean;
}

export function FramedPageNavigation({
  children,
  className,
  padded,
  ...props
}: FramedPageNavigationProps) {
  const gutterOwner = useFramedPageGutterOwner();
  const usesLocalPadding = padded ?? gutterOwner === "framed-page";
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-5xl min-w-0 shrink-0 pb-2",
        usesLocalPadding && "px-4 sm:px-6 lg:px-8",
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
  /** Adds a local inset only when the body is a deliberately nested region. */
  padded?: boolean;
}

export function FramedPageBody({
  children,
  className,
  scroll = "page",
  padded,
  ...props
}: FramedPageBodyProps) {
  const gutterOwner = useFramedPageGutterOwner();
  const usesLocalPadding = padded ?? gutterOwner === "framed-page";
  return (
    <div
      className={cn(
        "mx-auto flex min-h-0 w-full max-w-5xl min-w-0 flex-1 flex-col",
        usesLocalPadding && "px-4 sm:px-6 lg:px-8",
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
