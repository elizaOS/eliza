/**
 * Defines the shared Settings layout primitives that keep section groups and
 * rows consistent across built-in and plugin-provided settings panels.
 */
import { ChevronRight } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

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
  return <div className={cn("flex flex-col gap-8", className)} {...props} />;
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
  /** Drop the card chrome and render children directly (custom content). */
  bare?: boolean;
  children?: React.ReactNode;
}

export function SettingsGroup({
  title,
  description,
  action,
  footer,
  bare = false,
  className,
  children,
  ...props
}: SettingsGroupProps) {
  const hasHeader = Boolean(title || description || action);
  return (
    <section className={cn("flex flex-col gap-1.5", className)} {...props}>
      {hasHeader ? (
        <div className="flex min-h-[1.5rem] flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            {title ? (
              <h3 className="text-xs font-medium text-muted/70">{title}</h3>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-muted/80">
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {/* Flat list — no card, no dividers; rows breathe via their own spacing. */}
      {bare ? children : <div className="flex flex-col">{children}</div>}
      {footer ? (
        <p className="pt-1 text-xs leading-relaxed text-muted/70">{footer}</p>
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
  label,
  description,
  control,
  htmlFor,
  tone,
  trailing,
  chevron,
}: Pick<
  SettingsRowProps,
  | "icon"
  | "iconClassName"
  | "label"
  | "description"
  | "control"
  | "htmlFor"
  | "tone"
  | "trailing"
  | "chevron"
>) {
  const LabelTag = htmlFor ? "label" : "span";
  return (
    <div className="flex w-full items-center gap-3">
      {Icon ? (
        <Icon
          className={cn(
            "h-[18px] w-[18px] shrink-0 text-muted/80",
            tone === "danger" && "text-warn",
            iconClassName,
          )}
          aria-hidden
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <LabelTag
          {...(htmlFor ? { htmlFor } : {})}
          className={cn(
            "text-sm font-medium leading-5 text-txt-strong",
            tone === "danger" && "text-warn",
            htmlFor && "cursor-pointer",
          )}
        >
          {label}
        </LabelTag>
        {description ? (
          <span className="text-xs leading-relaxed text-muted">
            {description}
          </span>
        ) : null}
      </span>
      {control ? <span className="shrink-0">{control}</span> : null}
      {trailing ??
        (chevron ? (
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted/70"
            aria-hidden
          />
        ) : null)}
    </div>
  );
}

export function SettingsRow({
  icon,
  iconClassName,
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
        variant="ghost"
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        className={cn(
          "group flex w-full min-h-[3rem] items-center justify-start whitespace-normal rounded-lg px-2 py-2.5 text-left transition-colors",
          "hover:bg-surface/70    ",
          active && "bg-accent/10 hover:bg-accent/12",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        {...buttonProps}
      >
        <SettingsRowBody
          icon={icon}
          iconClassName={iconClassName}
          label={label}
          description={description}
          control={control}
          tone={tone}
          trailing={trailing}
          chevron={chevron ?? true}
        />
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[3rem] flex-col justify-center py-2.5",
        className,
      )}
    >
      <SettingsRowBody
        icon={icon}
        iconClassName={iconClassName}
        label={label}
        description={description}
        control={stacked ? undefined : control}
        htmlFor={htmlFor}
        tone={tone}
        trailing={trailing}
        chevron={chevron}
      />
      {children ? (
        <div className={cn(stacked ? "mt-3" : "mt-2")}>{children}</div>
      ) : null}
    </div>
  );
}
