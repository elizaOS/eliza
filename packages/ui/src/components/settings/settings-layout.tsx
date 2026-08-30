/**
 * Defines the shared Settings layout primitives that keep section groups and
 * rows consistent across built-in and plugin-provided settings panels.
 */
import { ChevronRight } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

/**
 * Settings layout vocabulary.
 *
 * Three primitives compose every settings section so the whole surface looks
 * standardized and stays easy to scan + edit on a phone:
 *
 *  - {@link SettingsStack}  vertical rhythm wrapper for a section's groups
 *  - {@link SettingsGroup}  a titled card of related rows (iOS-style grouped list)
 *  - {@link SettingsRow}    one row: leading icon, label + description, trailing
 *                           control — or a tappable navigation/action row
 *
 * Section authors should not hand-roll `flex flex-col gap-2 sm:flex-row`
 * layouts anymore; reach for these instead.
 */

export function SettingsStack({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="settings-stack"
      className={cn(
        "settings-surface flex flex-col gap-7 min-[700px]:gap-10",
        className,
      )}
      {...props}
    />
  );
}

export interface SettingsGroupProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** Group heading shown above the card. */
  title?: React.ReactNode;
  /** Supporting copy under the title. */
  description?: React.ReactNode;
  /** Trailing control aligned with the title (e.g. an "Add" button). */
  action?: React.ReactNode;
  /** Helper / disclaimer rendered under the card. */
  footer?: React.ReactNode;
  /** Heading level for the group title. Section bodies default to h3. */
  headingLevel?: 2 | 3;
  /** Drop the card chrome and render children directly (custom content). */
  bare?: boolean;
  children?: React.ReactNode;
}

export function SettingsGroup({
  title,
  description,
  action,
  footer,
  headingLevel = 3,
  bare = false,
  className,
  children,
  ...props
}: SettingsGroupProps) {
  const hasHeader = Boolean(title || description || action);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      data-slot="settings-group"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    >
      {hasHeader ? (
        <div
          data-slot="settings-group-header"
          className="flex min-h-6 flex-wrap items-end justify-between gap-x-3 gap-y-2 px-1"
        >
          <div className="min-w-0">
            {title ? (
              <Heading
                data-slot="settings-group-title"
                className="text-[13px] font-semibold uppercase leading-5 tracking-[0.04em] text-[color:var(--settings-muted)]"
              >
                {title}
              </Heading>
            ) : null}
            {description ? (
              <p
                data-slot="settings-group-description"
                className="mt-1 text-[13px] leading-5 text-[color:var(--settings-muted)]"
              >
                {description}
              </p>
            ) : null}
          </div>
          {action ? (
            <div data-slot="settings-group-action" className="shrink-0">
              {action}
            </div>
          ) : null}
        </div>
      ) : null}
      {bare ? (
        children
      ) : (
        <Card
          surface="card"
          border="standard"
          radius="xlarge"
          data-slot="settings-group-surface"
          className="overflow-hidden"
        >
          <div
            data-slot="settings-group-rows"
            className="settings-group-rows flex flex-col"
          >
            {children}
          </div>
        </Card>
      )}
      {footer ? (
        <p
          data-slot="settings-group-footer"
          className="px-1 text-xs leading-5 text-[color:var(--settings-muted)]"
        >
          {footer}
        </p>
      ) : null}
    </section>
  );
}

type SettingsRowTone = "default" | "danger";

export interface SettingsRowProps {
  /**
   * Leading icon rendered in a neutral medallion. Accepts any component that
   * takes `className`/`aria-hidden` (lucide icons and the generic provider icons
   * both satisfy this) — the row only passes those two props.
   */
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  iconClassName?: string;
  /** Optional paint and geometry for a leading icon medallion. */
  iconContainerClassName?: string;
  /** Primary label. */
  label: React.ReactNode;
  /** Secondary description under the label. */
  description?: React.ReactNode;
  /**
   * Trailing control kept inline with the label (Switch, small Select,
   * Button). For wide controls (Input, Textarea, full Select) pass them as
   * `children` with `stacked` instead.
   */
  control?: React.ReactNode;
  /**
   * Wide control area rendered full-width below the label block. Combine with
   * `stacked` for inputs/textareas that need the whole row width on mobile.
   */
  children?: React.ReactNode;
  /** Render `children` full-width under the label rather than inline. */
  stacked?: boolean;
  /** Makes the whole row a button (navigation / action). Adds a chevron. */
  onClick?: () => void;
  /** Ref forwarded to the underlying nav button (for agent-surface wiring). */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /**
   * Extra data-* attributes spread onto the nav button (agent-surface wiring).
   * Typed as a data-attribute record since React's button props don't declare a
   * `data-*` index signature.
   */
  buttonProps?: Record<`data-${string}`, string | undefined>;
  /** Highlight the row as the currently-selected destination (nav rail). */
  active?: boolean;
  /** Override the trailing affordance (defaults to a chevron for nav rows). */
  trailing?: React.ReactNode;
  /** Force-show the chevron affordance. */
  chevron?: boolean;
  /** Associate the label with a control id (taps the label to focus it). */
  htmlFor?: string;
  tone?: SettingsRowTone;
  disabled?: boolean;
  className?: string;
}

function SettingsRowBody({
  icon: Icon,
  iconClassName,
  iconContainerClassName,
  label,
  description,
  control,
  htmlFor,
  tone,
  trailing,
  chevron,
  interactive = false,
}: Pick<
  SettingsRowProps,
  | "icon"
  | "iconClassName"
  | "iconContainerClassName"
  | "label"
  | "description"
  | "control"
  | "htmlFor"
  | "tone"
  | "trailing"
  | "chevron"
> & { interactive?: boolean }) {
  const LabelTag = htmlFor ? "label" : "span";
  const resolvedTrailing =
    trailing ??
    (chevron ? (
      <ChevronRight
        data-slot="settings-row-chevron"
        className="size-4 text-[color:var(--settings-muted)]"
        aria-hidden
      />
    ) : null);
  const hasTrailing = trailing != null || Boolean(chevron);
  return (
    <div
      data-slot="settings-row-body"
      className={cn(
        "flex w-full items-center px-5",
        interactive &&
          "min-h-12 py-2.5 transition-colors group-focus-visible:ring-2 group-focus-visible:ring-[color:var(--settings-ring)] group-focus-visible:ring-inset",
      )}
    >
      {Icon ? (
        <span
          data-slot="settings-row-icon-container"
          aria-hidden
          className={cn(
            "mr-3 flex shrink-0 items-center justify-center",
            iconContainerClassName,
          )}
        >
          <Icon
            className={cn(
              "h-[18px] w-[18px] shrink-0",
              iconContainerClassName
                ? "text-current"
                : "text-[color:var(--settings-muted)]",
              tone === "danger" && "text-warn",
              iconClassName,
            )}
            aria-hidden
          />
        </span>
      ) : null}
      <span
        data-slot="settings-row-copy"
        className="flex min-w-0 flex-1 flex-col"
      >
        <LabelTag
          data-slot="settings-row-label"
          {...(htmlFor ? { htmlFor } : {})}
          className={cn(
            "text-[15px] font-medium leading-6 text-[color:var(--settings-foreground)] group-disabled:text-[color:var(--settings-muted)]",
            tone === "danger" && "text-warn",
            htmlFor && "cursor-pointer",
          )}
        >
          {label}
        </LabelTag>
        {description ? (
          <span
            data-slot="settings-row-description"
            className="text-[13px] leading-5 text-[color:var(--settings-muted)]"
          >
            {description}
          </span>
        ) : null}
      </span>
      {control ? (
        <span data-slot="settings-row-control" className="ml-6 shrink-0">
          {control}
        </span>
      ) : null}
      {hasTrailing ? (
        <span
          data-slot="settings-row-trailing"
          className={cn("shrink-0", control ? "ml-3" : "ml-6")}
        >
          {resolvedTrailing}
        </span>
      ) : null}
    </div>
  );
}

export function SettingsRow({
  icon,
  iconClassName,
  iconContainerClassName,
  label,
  description,
  control,
  children,
  stacked = false,
  onClick,
  buttonRef,
  buttonProps,
  active = false,
  trailing,
  chevron,
  htmlFor,
  tone = "default",
  disabled = false,
  className,
}: SettingsRowProps) {
  // Full-width content (the page owns horizontal padding). Nav rows keep the
  // 48px touch target while avoiding extra horizontal bleed that makes the
  // mobile settings hub read denser in the app visual audit.
  if (onClick) {
    return (
      <Button
        ref={buttonRef}
        variant="settingsRow"
        size="rowContent"
        align="start"
        data-slot="settings-row"
        data-state={active ? "on" : "off"}
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        className={cn("group w-full", className)}
        {...buttonProps}
      >
        <SettingsRowBody
          icon={icon}
          iconClassName={iconClassName}
          iconContainerClassName={iconContainerClassName}
          label={label}
          description={description}
          control={control}
          tone={tone}
          trailing={trailing}
          chevron={chevron ?? true}
          interactive
        />
      </Button>
    );
  }

  return (
    <Card
      asChild
      variant="transparent"
      flow="column"
      surface={active ? "raised" : "transparent"}
      radius={active ? "large" : "none"}
    >
      <div
        data-slot="settings-row"
        aria-current={active ? "true" : undefined}
        className={cn("min-h-12 justify-center py-2.5", className)}
      >
        <SettingsRowBody
          icon={icon}
          iconClassName={iconClassName}
          iconContainerClassName={iconContainerClassName}
          label={label}
          description={description}
          control={stacked ? undefined : control}
          htmlFor={htmlFor}
          tone={tone}
          trailing={trailing}
          chevron={chevron}
        />
        {children ? (
          <div
            data-slot="settings-row-content"
            className={cn("px-5", stacked ? "mt-3" : "mt-2")}
          >
            {children}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
