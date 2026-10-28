/**
 * Shared Home cards of the daily overview: the agenda, attention (mail) and
 * latest brief. They render presentation models from `daily-overview.ts` and
 * read nothing themselves: no provider read, sync or digest run starts here.
 *
 * Presentation is brand-neutral. Every part carries `data-overview-part`;
 * hosts theme the cards with their own classes (`classNames`) or inline styles
 * (`styles`, `style` for the root) and may add compatibility attributes to the
 * root and to any part (`dataAttributes`, `partAttributes`) so installed
 * selectors keep working.
 */
import type { CSSProperties, ReactNode } from "react";
import type { OverviewInboxCardState } from "./daily-overview";

/** Extra attributes for one rendered part (for example `data-*` hooks). */
export type OverviewPartAttributes = Record<string, string | undefined>;

interface OverviewCardBaseProps<Part extends string> {
  /** Stable accessible name of the card button. */
  label: string;
  /** Full sentence exposed as the card's accessible description. */
  description?: string;
  onActivate?: () => void;
  /** Host classes per part; `card` is the root button. */
  classNames?: Partial<Record<Part | "card", string>>;
  /** Host attributes per part; `card` is the root button. */
  partAttributes?: Partial<Record<Part | "card", OverviewPartAttributes>>;
  /** Host inline styles per part (theme tokens, layout); the root uses `style`. */
  styles?: Partial<Record<Part, CSSProperties>>;
  /** Root `data-*` attributes; each card's own `data-overview-*` state flags take precedence. */
  dataAttributes?: OverviewPartAttributes;
  style?: CSSProperties;
  /** Decorative icon in the card head. */
  icon?: ReactNode;
}

function partProps<Part extends string>(
  props: Pick<
    OverviewCardBaseProps<Part>,
    "classNames" | "partAttributes" | "styles"
  >,
  part: Part | "card",
) {
  const style = part === "card" ? undefined : props.styles?.[part as Part];
  return {
    "data-overview-part": part,
    ...(props.classNames?.[part] ? { className: props.classNames[part] } : {}),
    ...(style ? { style } : {}),
    ...(props.partAttributes?.[part] ?? {}),
  };
}

/** Host root attributes without `data-overview-*` keys, which belong to the card. */
function hostDataAttributes(
  attributes: OverviewPartAttributes | undefined,
): OverviewPartAttributes {
  if (!attributes) return {};
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !key.startsWith("data-overview-")),
  );
}

function flag(value: boolean): string {
  return value ? "true" : "false";
}

export type OverviewAgendaPart =
  | "head"
  | "heading"
  | "origin"
  | "icon"
  | "video"
  | "title"
  | "meta"
  | "footer"
  | "source"
  | "next"
  | "nextText"
  | "nextSource";

export interface OverviewAgendaCardProps
  extends OverviewCardBaseProps<OverviewAgendaPart> {
  /** The item's day, or that reminders are overdue. */
  heading: string;
  /** Calendar name, or "Reminder", beside the heading. */
  origin: string;
  /** Item title, or the empty/loading/error title. */
  title: string;
  /** Time of the shown item; rendered only with `hasItem`. */
  footer: string;
  hasItem: boolean;
  /** Read line: retry after a failed read, or staleness. */
  source: string;
  /** Under an overdue reminder, the next item with its own source. */
  next?: { text: string; source: string } | null;
  overdue: boolean;
  /** The last completed read is from an earlier day. */
  stale?: boolean;
  /** Shown when the item has a meeting link. */
  videoIcon?: ReactNode;
}

/** Agenda card: today's next calendar item or the overdue reminder first. */
export function OverviewAgendaCard(props: OverviewAgendaCardProps) {
  const hasMeta = props.hasItem || !!props.source;
  const next = props.next?.text ? props.next : null;
  const state = props.hasItem ? (props.overdue ? "overdue" : "item") : "empty";
  return (
    <button
      type="button"
      {...partProps(props, "card")}
      data-overview-card="agenda"
      data-overview-state={props.stale ? "stale" : state}
      data-overview-has-item={flag(props.hasItem)}
      data-overview-has-meta={flag(hasMeta)}
      data-overview-overdue={flag(props.overdue)}
      data-overview-has-next={flag(!!next)}
      {...hostDataAttributes(props.dataAttributes)}
      aria-label={props.label}
      aria-description={props.description || undefined}
      onClick={props.onActivate}
      style={props.style}
    >
      <div {...partProps(props, "head")}>
        <span {...partProps(props, "heading")}>{props.heading}</span>
        <span {...partProps(props, "origin")}>{props.origin}</span>
        {props.icon ? (
          <span aria-hidden="true" {...partProps(props, "icon")}>
            {props.icon}
          </span>
        ) : null}
      </div>
      {props.videoIcon ? (
        <span aria-hidden="true" {...partProps(props, "video")}>
          {props.videoIcon}
        </span>
      ) : null}
      <div {...partProps(props, "title")}>{props.title}</div>
      {hasMeta ? (
        <span {...partProps(props, "meta")}>
          {props.hasItem ? (
            <span {...partProps(props, "footer")}>{props.footer}</span>
          ) : null}
          {props.source ? (
            <span {...partProps(props, "source")}>{props.source}</span>
          ) : null}
        </span>
      ) : null}
      {next ? (
        <span {...partProps(props, "next")}>
          <span {...partProps(props, "nextText")}>{next.text}</span>
          {next.source ? (
            <span {...partProps(props, "nextSource")}>{next.source}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

export type OverviewAttentionPart =
  | "head"
  | "count"
  | "icon"
  | "rows"
  | "row"
  | "rowTitle"
  | "rowDetail"
  | "title"
  | "status"
  | "people"
  | "person";

export interface OverviewAttentionCardProps
  extends OverviewCardBaseProps<OverviewAttentionPart> {
  /** Unread count line, "—" when unknown, "!" after a failure. */
  count: string;
  /** Up to a few loaded rows (subject and sender); never message bodies. */
  rows?: readonly { title: string; detail: string }[];
  /** Headline when no rows are shown ("No unread email", "Connect email"). */
  title: string;
  /** Account and read time, retry or staleness. */
  status: string;
  /** Attendee or sender initials, decorative. */
  people?: readonly string[];
  /** `presentOverviewInboxCard().state`; `idle` is connected with nothing loaded. */
  state?: OverviewInboxCardState;
}

/** Attention card: unread mail from the last read the user loaded. */
export function OverviewAttentionCard(props: OverviewAttentionCardProps) {
  const rows = props.rows ?? [];
  const people = props.people ?? [];
  return (
    <button
      type="button"
      {...partProps(props, "card")}
      data-overview-card="attention"
      data-overview-state={props.state ?? (rows.length ? "ready" : "empty")}
      {...hostDataAttributes(props.dataAttributes)}
      aria-label={props.label}
      aria-description={props.description || undefined}
      onClick={props.onActivate}
      style={props.style}
    >
      <div {...partProps(props, "head")}>
        <span {...partProps(props, "count")}>{props.count}</span>
        {props.icon ? (
          <span aria-hidden="true" {...partProps(props, "icon")}>
            {props.icon}
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <div {...partProps(props, "rows")}>
          {rows.map((row, index) => (
            // Rows have no stable identity beyond their position in one read.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of one read
            <div key={index} {...partProps(props, "row")}>
              <div {...partProps(props, "rowTitle")}>{row.title}</div>
              <div {...partProps(props, "rowDetail")}>{row.detail}</div>
            </div>
          ))}
        </div>
      ) : null}
      {props.title ? (
        <span {...partProps(props, "title")}>{props.title}</span>
      ) : null}
      <span {...partProps(props, "status")}>{props.status}</span>
      {people.length ? (
        <div aria-hidden="true" {...partProps(props, "people")}>
          {people.map((initials, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: decorative initials may repeat
            <span key={index} {...partProps(props, "person")}>
              {initials}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

export type OverviewBriefPart =
  | "head"
  | "heading"
  | "icon"
  | "title"
  | "status";

export interface OverviewBriefCardProps
  extends OverviewCardBaseProps<OverviewBriefPart> {
  /** Card heading. */
  heading?: string;
  title: string;
  /** Agent and run time ("Eliza · Ran 7:02 AM"). */
  status: string;
  failed: boolean;
}

/**
 * Latest brief card. Render it only when a retained brief exists
 * (`presentOverviewBriefCard().has`); there is no placeholder brief.
 */
export function OverviewBriefCard(props: OverviewBriefCardProps) {
  return (
    <button
      type="button"
      {...partProps(props, "card")}
      data-overview-card="brief"
      data-overview-state={props.failed ? "failed" : "ready"}
      data-overview-failed={flag(props.failed)}
      {...hostDataAttributes(props.dataAttributes)}
      aria-label={props.label}
      aria-description={props.description || undefined}
      aria-haspopup="dialog"
      onClick={props.onActivate}
      style={props.style}
    >
      <div {...partProps(props, "head")}>
        <span {...partProps(props, "heading")}>
          {props.heading ?? "Latest brief"}
        </span>
        {props.icon ? (
          <span aria-hidden="true" {...partProps(props, "icon")}>
            {props.icon}
          </span>
        ) : null}
      </div>
      <span {...partProps(props, "title")}>{props.title}</span>
      <span {...partProps(props, "status")}>{props.status}</span>
    </button>
  );
}
