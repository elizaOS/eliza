/**
 * Owns shared empty, loading, and recovery presentation inside page panels
 * while preserving each placement's container and accessibility behavior.
 */
import type * as React from "react";

import { cn } from "../../../lib/utils";
import { Card } from "../../ui/card";
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

export interface ErrorContentStateProps extends ContentStateBaseProps {
  state: "error";
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  tone?: "danger" | "warning";
}

export type ContentStateProps =
  | EmptyContentStateProps
  | LoadingContentStateProps
  | ErrorContentStateProps;

function PlainEmptyContent({
  action,
  children,
  description,
  icon,
  title,
}: Pick<
  EmptyContentStateProps,
  "action" | "children" | "description" | "icon" | "title"
>) {
  return (
    <>
      {icon ? (
        <Card variant="accentTile" className="mb-3 size-12">
          {icon}
        </Card>
      ) : null}
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

function ErrorContent({
  action,
  description,
  icon,
  title,
  tone,
}: Pick<
  ErrorContentStateProps,
  "action" | "description" | "icon" | "title" | "tone"
>) {
  return (
    <div className="flex max-w-md flex-col items-center text-center">
      {icon ? (
        <Card
          variant={tone === "warning" ? "warningNotice" : "dangerNotice"}
          className="grid size-12 place-items-center p-0"
          aria-hidden="true"
        >
          <span className={tone === "warning" ? "text-warning" : "text-danger"}>
            {icon}
          </span>
        </Card>
      ) : null}
      <div
        className={cn(
          "text-base font-semibold text-txt-strong",
          icon && "mt-4",
        )}
      >
        {title}
      </div>
      {description ? (
        <div className="mt-2 text-sm leading-5 text-muted">{description}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
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
            icon={icon}
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
            icon={icon}
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

  if (props.state === "error") {
    const {
      action,
      className,
      description,
      icon,
      placement = "panel",
      role = "alert",
      state: _state,
      title,
      tone = "danger",
      ...containerProps
    } = props;
    const content = (
      <ErrorContent
        action={action}
        description={description}
        icon={icon}
        title={title}
        tone={tone}
      />
    );
    const commonClassName =
      "flex flex-col items-center justify-center px-4 py-8 text-center";

    if (placement === "surface") {
      return (
        <PagePanelRoot
          className={cn("min-h-[42vh]", commonClassName, className)}
          role={role}
          {...containerProps}
        >
          {content}
        </PagePanelRoot>
      );
    }

    if (placement === "workspace") {
      return (
        <div
          className={cn("min-h-0 flex-1", commonClassName, className)}
          role={role}
          {...containerProps}
        >
          {content}
        </div>
      );
    }

    return (
      <div
        className={cn(
          placement === "inset" ? "min-h-[10rem]" : "min-h-[12rem]",
          commonClassName,
          className,
        )}
        role={role}
        {...containerProps}
      >
        {content}
      </div>
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
