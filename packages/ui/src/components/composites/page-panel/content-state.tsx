/**
 * Owns the shared empty and loading presentation used inside page panels while
 * preserving each placement's existing container and accessibility behavior.
 */
import type * as React from "react";

import { cn } from "../../../lib/utils";
import { EmptyState } from "../../ui/empty-state";
import { Spinner } from "../../ui/spinner";
import { PagePanelRoot } from "./page-panel-root";

type ContentStatePlacement = "panel" | "inset" | "surface" | "workspace";

interface ContentStateBaseProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "children"> {
  placement?: ContentStatePlacement;
}

export interface EmptyContentStateProps extends ContentStateBaseProps {
  state: "empty";
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

export interface LoadingContentStateProps extends ContentStateBaseProps {
  state: "loading";
  heading: React.ReactNode;
  description?: React.ReactNode;
  placement?: Exclude<ContentStatePlacement, "inset">;
}

export type ContentStateProps =
  | EmptyContentStateProps
  | LoadingContentStateProps;

function PlainEmptyContent({
  action,
  children,
  description,
  title,
}: Pick<
  EmptyContentStateProps,
  "action" | "children" | "description" | "title"
>) {
  return (
    <>
      <div className="max-w-md space-y-2">
        <div className="text-base font-medium text-txt-strong">{title}</div>
        {description ? (
          <div className="text-sm text-muted">{description}</div>
        ) : null}
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
      {children}
    </>
  );
}

function LoadingContent({
  description,
  heading,
}: Pick<LoadingContentStateProps, "description" | "heading">) {
  return (
    <>
      <Spinner size={20} />
      <div className="mt-4 max-w-md space-y-2">
        <div className="text-base font-medium text-txt-strong">{heading}</div>
        {description ? <div className="sr-only">{description}</div> : null}
      </div>
    </>
  );
}

export function ContentState(props: ContentStateProps) {
  if (props.state === "empty") {
    const {
      action,
      children,
      className,
      description,
      icon,
      placement = "panel",
      state: _state,
      title,
      ...containerProps
    } = props;

    if (placement === "surface") {
      return (
        <PagePanelRoot
          className={cn(
            "flex min-h-[42vh] flex-col items-center justify-center px-4 py-8 text-center",
            className,
          )}
          {...containerProps}
        >
          <PlainEmptyContent
            action={action}
            description={description}
            title={title}
          >
            {children}
          </PlainEmptyContent>
        </PagePanelRoot>
      );
    }

    if (placement === "workspace") {
      return (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-8 text-center",
            className,
          )}
          {...containerProps}
        >
          <PlainEmptyContent
            action={action}
            description={description}
            title={title}
          >
            {children}
          </PlainEmptyContent>
        </div>
      );
    }

    return (
      <EmptyState
        className={cn(
          placement === "inset"
            ? "min-h-[10rem] px-4 py-8"
            : "min-h-[12rem] px-4 py-8",
          className,
        )}
        description={description}
        icon={icon}
        title={title}
        {...containerProps}
      >
        {children}
        {action ? <div className="mt-4">{action}</div> : null}
      </EmptyState>
    );
  }

  const {
    className,
    description,
    heading,
    placement = "panel",
    state: _state,
    ...containerProps
  } = props;

  if (placement === "surface") {
    return (
      <PagePanelRoot
        className={cn(
          "flex min-h-[42vh] flex-col items-center justify-center px-4 py-8 text-center",
          className,
        )}
        {...containerProps}
      >
        <LoadingContent description={description} heading={heading} />
      </PagePanelRoot>
    );
  }

  if (placement === "workspace") {
    return (
      <PagePanelRoot
        variant="workspace"
        className={cn(
          "items-center justify-center px-4 py-8 text-center",
          className,
        )}
        {...containerProps}
      >
        <LoadingContent description={description} heading={heading} />
      </PagePanelRoot>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[12rem] flex-col items-center justify-center px-4 py-8 text-center",
        className,
      )}
      {...containerProps}
    >
      <LoadingContent description={description} heading={heading} />
    </div>
  );
}
