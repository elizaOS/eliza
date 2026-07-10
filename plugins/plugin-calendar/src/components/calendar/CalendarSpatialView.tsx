/**
 * CalendarSpatialView — the calendar surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI today through `<SpatialSurface>` (DOM).
 *   - Future adapters can reuse the same snapshot contract behind the retained modality types.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports ONLY the cross-modality primitives, so it is safe to render
 * without pulling browser-only runtime imports into the presentational layer.
 *
 * A terminal calendar is an AGENDA list, not a pixel grid: each row is a time +
 * title with a trailing "Open" control. The header carries the period label,
 * prev/today/next nav, the day/week/month selector, and a "New" button.
 */

import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Which range the calendar surface is currently showing. */
export type CalendarMode = "day" | "week" | "month";

/** Meeting-join affordance state for a row with a recognized conference link. */
export type CalendarRowMeetingState = "available" | "requesting" | "live";

/** One presentational agenda row (already formatted for display). */
export interface CalendarEventRow {
  id: string;
  title: string;
  /** Pre-formatted time/range label, e.g. "9:00 AM - 10:00 AM" or "All day". */
  when: string;
  /** Optional secondary line (location / source calendar). */
  detail?: string;
  selected?: boolean;
  /**
   * Present only when the event has a Meet/Teams/Zoom link the agent can
   * join: `available` renders a "Send agent" control (action `join:<id>`),
   * `requesting` a disabled in-flight label, `live` an "In meeting" badge.
   */
  meeting?: CalendarRowMeetingState;
}

export interface CalendarSnapshot {
  /** Upcoming events for the active window, already sorted + formatted. */
  events: CalendarEventRow[];
  /** Human-readable label for the active range, e.g. "June 2026". */
  periodLabel: string;
  /** Active view mode. */
  mode: CalendarMode;
  loading?: boolean;
  error?: string | null;
}

const MODE_LABELS: Record<CalendarMode, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

const MODES: CalendarMode[] = ["day", "week", "month"];

export interface CalendarSpatialViewProps {
  snapshot: CalendarSnapshot;
  /**
   * Dispatch by agent id: `prev`, `today`, `next`, `new`, `mode:<m>`,
   * `select:<id>`.
   */
  onAction?: (action: string) => void;
}

export function CalendarSpatialView({
  snapshot,
  onAction,
}: CalendarSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const eventCount = snapshot.events.length;

  return (
    // shrink={0}: the host SpatialSurface is a height-constrained scrollport
    // (overflow-y auto). Left shrinkable, a short viewport (mobile landscape,
    // ~390px tall) compresses every toolbar/agenda row below its content
    // height — the 44px-min buttons and two-line rows then overprint each
    // other instead of the surface scrolling (#15911).
    <Card gap={1} padding={1} shrink={0}>
      <HStack gap={1} align="center">
        <Text style="subheading" bold grow={1} wrap={false}>
          {snapshot.periodLabel}
        </Text>
        <Button
          variant="outline"
          tone="default"
          agent="prev"
          onPress={dispatch("prev")}
        >
          ‹
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="today"
          onPress={dispatch("today")}
        >
          Today
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="next"
          onPress={dispatch("next")}
        >
          ›
        </Button>
      </HStack>

      <HStack gap={1} align="center">
        <Field
          kind="select"
          label="View"
          value={snapshot.mode}
          options={MODES}
          agent="mode"
          onChange={(value) => onAction?.(`mode:${value}`)}
          grow={1}
        />
        <Button agent="new" onPress={dispatch("new")}>
          New
        </Button>
      </HStack>

      <HStack gap={1} align="center">
        {MODES.map((mode) => (
          <Button
            key={mode}
            variant={mode === snapshot.mode ? "solid" : "outline"}
            tone="default"
            agent={`mode:${mode}`}
            onPress={dispatch(`mode:${mode}`)}
            grow={1}
          >
            {MODE_LABELS[mode]}
          </Button>
        ))}
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <Divider label="agenda" />

      <CalendarAgendaBody
        snapshot={snapshot}
        eventCount={eventCount}
        dispatch={dispatch}
      />
    </Card>
  );
}

function CalendarAgendaBody({
  snapshot,
  eventCount,
  dispatch,
}: {
  snapshot: CalendarSnapshot;
  eventCount: number;
  dispatch: (action: string) => () => void;
}) {
  if (eventCount === 0) {
    return (
      <Text tone="muted" align="center" style="caption">
        {snapshot.loading ? "Loading" : "None"}
      </Text>
    );
  }

  return (
    <List gap={0}>
      {snapshot.events.slice(0, 12).map((event) => (
        <HStack key={event.id} gap={1} align="center" agent={`row-${event.id}`}>
          <Text tone="muted" wrap={false}>
            {event.selected ? "›" : "•"}
          </Text>
          <VStack gap={0} grow={1}>
            <Text bold wrap={false}>
              {event.title}
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              {event.detail ? `${event.when} · ${event.detail}` : event.when}
            </Text>
          </VStack>
          {event.meeting === "live" ? (
            <Text style="caption" bold wrap={false}>
              ● In meeting
            </Text>
          ) : null}
          {event.meeting === "requesting" ? (
            <Text style="caption" tone="muted" wrap={false}>
              Sending…
            </Text>
          ) : null}
          {event.meeting === "available" ? (
            <Button
              variant="outline"
              tone="default"
              agent={`join:${event.id}`}
              onPress={dispatch(`join:${event.id}`)}
            >
              Send agent
            </Button>
          ) : null}
          <Button
            variant="outline"
            tone="default"
            agent={`select:${event.id}`}
            onPress={dispatch(`select:${event.id}`)}
          >
            Open
          </Button>
        </HStack>
      ))}
    </List>
  );
}
