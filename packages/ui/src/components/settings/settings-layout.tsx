import { ChevronRight, type LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

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
  return <div className={cn("flex flex-col gap-6", className)} {...props} />;
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
    <section className={cn("flex flex-col gap-2.5", className)} {...props}>
      {hasHeader ? (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            {title ? (
              <h3 className="text-sm font-medium text-txt-strong">{title}</h3>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-muted/90">
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {bare ? (
        children
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card">
          {children}
        </div>
      )}
      {footer ? (
        <p className="px-1 text-xs leading-relaxed text-muted/80">{footer}</p>
      ) : null}
    </section>
  );
}

type SettingsRowTone = "default" | "danger";

export interface SettingsRowProps {
  /** Leading icon rendered in a neutral medallion. */
  icon?: LucideIcon;
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
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-txt-strong ring-1 ring-border/70",
            tone === "danger" && "bg-warn/12 text-warn ring-warn/20",
            iconClassName,
          )}
        >
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
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
  const padding = "px-4 py-3";

  if (onClick) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        className={cn(
          "group flex w-full min-h-[3.25rem] items-center text-left transition-colors",
          "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
          active && "bg-accent/10 hover:bg-accent/12",
          disabled && "cursor-not-allowed opacity-50",
          padding,
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
      </button>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[3.25rem] flex-col justify-center",
        padding,
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
