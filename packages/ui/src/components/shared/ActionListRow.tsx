/**
 * Canonical single-action list row with native button, link, or static
 * semantics and shared leading, copy, metadata, and trailing slots.
 */
import type * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

type ActionListRowDensity = "compact" | "default";
type ActionListRowAlignment = "center" | "start";

interface ActionListRowContentProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  metadata?: React.ReactNode;
  trailing?: React.ReactNode;
  selected?: boolean;
  density?: ActionListRowDensity;
  alignment?: ActionListRowAlignment;
}

export interface ActionListRowButtonProps
  extends ActionListRowContentProps,
    Omit<
      React.ButtonHTMLAttributes<HTMLButtonElement>,
      "children" | "className" | "disabled" | "title"
    > {
  element?: "button";
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}

export interface ActionListRowLinkProps
  extends ActionListRowContentProps,
    Omit<
      React.AnchorHTMLAttributes<HTMLAnchorElement>,
      "children" | "className" | "href" | "title"
    > {
  element: "link";
  href: string;
  disabled?: boolean;
  linkRef?: React.Ref<HTMLAnchorElement>;
}

export interface ActionListRowStaticProps
  extends ActionListRowContentProps,
    Omit<
      React.HTMLAttributes<HTMLDivElement>,
      "children" | "className" | "title"
    > {
  element: "static";
  staticRef?: React.Ref<HTMLDivElement>;
}

export type ActionListRowProps =
  | ActionListRowButtonProps
  | ActionListRowLinkProps
  | ActionListRowStaticProps;

function rowClassName({
  alignment = "center",
  density = "default",
}: Pick<ActionListRowContentProps, "alignment" | "density">) {
  return cn(
    "group flex h-auto w-full min-w-0 justify-start whitespace-normal text-left font-normal",
    alignment === "start" ? "items-start" : "items-center",
    density === "compact"
      ? "min-h-11 gap-2 px-2 py-2"
      : "min-h-12 gap-3 px-3 py-2.5",
  );
}

function ActionListRowContent({
  leading,
  title,
  description,
  metadata,
  trailing,
}: Pick<
  ActionListRowContentProps,
  "description" | "leading" | "metadata" | "title" | "trailing"
>) {
  return (
    <>
      {leading ? (
        <span className="flex shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium leading-5 text-txt-strong">
          {title}
        </span>
        {description ? (
          <span className="line-clamp-2 text-xs leading-relaxed text-muted">
            {description}
          </span>
        ) : null}
        {metadata ? (
          <span className="text-xs leading-relaxed text-muted-strong">
            {metadata}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center">{trailing}</span>
      ) : null}
    </>
  );
}

export function ActionListRow(props: ActionListRowProps) {
  if (props.element === "link") {
    const {
      alignment,
      density,
      description,
      disabled = false,
      element: _element,
      href,
      leading,
      linkRef,
      metadata,
      onClick,
      selected,
      tabIndex,
      title,
      trailing,
      ...anchorProps
    } = props;
    return (
      <Button
        asChild
        variant="selection"
        size="rowContent"
        data-state={selected ? "on" : "off"}
        className={rowClassName({ alignment, density })}
      >
        <a
          ref={linkRef}
          {...anchorProps}
          href={disabled ? undefined : href}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : tabIndex}
          onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
            if (disabled) {
              event.preventDefault();
              return;
            }
            onClick?.(event);
          }}
        >
          <ActionListRowContent
            leading={leading}
            title={title}
            description={description}
            metadata={metadata}
            trailing={trailing}
          />
        </a>
      </Button>
    );
  }

  if (props.element === "static") {
    const {
      alignment,
      density,
      description,
      element: _element,
      leading,
      metadata,
      selected,
      staticRef,
      title,
      trailing,
      ...divProps
    } = props;
    return (
      <Card asChild variant={selected ? "sidebarItemActive" : "transparent"}>
        <div
          ref={staticRef}
          data-state={selected ? "on" : "off"}
          className={rowClassName({ alignment, density })}
          {...divProps}
        >
          <ActionListRowContent
            leading={leading}
            title={title}
            description={description}
            metadata={metadata}
            trailing={trailing}
          />
        </div>
      </Card>
    );
  }

  const {
    buttonRef,
    alignment,
    density,
    description,
    disabled = false,
    element: _element,
    leading,
    metadata,
    selected,
    title,
    trailing,
    ...buttonProps
  } = props;
  return (
    <Button
      ref={buttonRef}
      variant="selection"
      size="rowContent"
      align="start"
      data-state={selected ? "on" : "off"}
      disabled={disabled}
      className={rowClassName({ alignment, density })}
      {...buttonProps}
    >
      <ActionListRowContent
        leading={leading}
        title={title}
        description={description}
        metadata={metadata}
        trailing={trailing}
      />
    </Button>
  );
}
