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
import type { CalendarSurfaceStatus } from "../../hooks/useCalendarWeek.js";
import type { CalendarSourceHealthRow } from "./source-health.js";
import type { CalendarSourceManagerSnapshot } from "./source-manager.js";

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
  loading: boolean;
  error: string | null;
  status: CalendarSurfaceStatus;
  sourceHeadline: string;
  sources: CalendarSourceHealthRow[];
  refreshing: boolean;
  sourceManager: CalendarSourceManagerSnapshot;
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

      <VStack
        gap={1}
        agent={{
          id: "calendar-sources",
          role: "status",
          label: snapshot.sourceHeadline,
        }}
      >
        <HStack gap={1} align="center">
          <Text
            style="caption"
            bold
            tone={
              snapshot.status === "error" || snapshot.status === "unavailable"
                ? "danger"
                : snapshot.status === "partial"
                  ? "warning"
                  : "muted"
            }
            grow={1}
          >
            {snapshot.sourceHeadline}
          </Text>
          <Button
            variant="ghost"
            tone="default"
            agent="refresh"
            disabled={snapshot.refreshing}
            onPress={dispatch("refresh")}
          >
            {snapshot.refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </HStack>
        {snapshot.sources.length > 0 ? (
          <List gap={0}>
            {snapshot.sources.map((source) => (
              <HStack key={source.id} gap={1} align="center">
                <Text style="caption" grow={1} wrap={false}>
                  {source.label}
                </Text>
                <Text style="caption" tone={source.tone} wrap={false}>
                  {source.freshnessLabel}
                </Text>
              </HStack>
            ))}
          </List>
        ) : snapshot.status !== "loading" && snapshot.status !== "error" ? (
          <Text style="caption" tone="muted">
            {snapshot.status === "unavailable"
              ? "No connected source details are available."
              : "No source details were reported for this view."}
          </Text>
        ) : null}
      </VStack>

      <VStack
        gap={1}
        agent={{
          id: "calendar-source-manager",
          role: "group",
          label: "Manage calendar sources",
        }}
      >
        <Button
          variant="ghost"
          tone="default"
          agent="manage-sources"
          onPress={dispatch("manage-sources")}
        >
          {snapshot.sourceManager.open
            ? "Close source settings"
            : "Manage calendar sources"}
        </Button>

        {snapshot.sourceManager.open ? (
          <>
            <Text style="caption" tone="muted">
              New calendars are included automatically. Exclude one to remove it
              from the combined calendar.
            </Text>

            {snapshot.sourceManager.status === "loading" ? (
              <Text style="caption" tone="muted">
                Loading calendar sources…
              </Text>
            ) : null}

            {snapshot.sourceManager.error ? (
              <HStack gap={1} align="center">
                <Text style="caption" tone="danger" grow={1}>
                  {snapshot.sourceManager.error}
                </Text>
                <Button
                  variant="outline"
                  tone="default"
                  agent="source-refresh"
                  onPress={dispatch("source-refresh")}
                >
                  Retry
                </Button>
              </HStack>
            ) : null}

            {snapshot.sourceManager.refreshError ? (
              <Text style="caption" tone="warning">
                {snapshot.sourceManager.refreshError}
              </Text>
            ) : null}

            {snapshot.sourceManager.status === "empty" &&
            snapshot.sourceManager.rows.length === 0 ? (
              <VStack gap={1}>
                <Text style="caption" tone="muted">
                  No calendar sources were found.
                </Text>
                <Button
                  variant="outline"
                  tone="default"
                  agent="source-settings"
                  onPress={dispatch("source-settings")}
                >
                  Open connector settings
                </Button>
              </VStack>
            ) : null}

            {snapshot.sourceManager.rows.length > 0 ? (
              <List gap={0}>
                {snapshot.sourceManager.rows.map((source) => (
                  <VStack
                    key={source.actionId}
                    gap={0}
                    agent={{
                      id: `source-row-${source.actionId}`,
                      role: "group",
                      label: `${source.providerLabel}, ${source.accountLabel}, ${source.calendarLabel}`,
                    }}
                  >
                    <HStack gap={1} align="center">
                      <VStack gap={0} grow={1}>
                        <Text bold wrap={false}>
                          {source.calendarLabel}
                          {source.primary &&
                          source.calendarLabel.trim().toLowerCase() !==
                            "primary"
                            ? " · Primary"
                            : ""}
                        </Text>
                        <Text style="caption" tone="muted">
                          {source.providerLabel} · {source.accountLabel}
                        </Text>
                      </VStack>
                      {source.toggleAvailable ? (
                        <Button
                          variant="outline"
                          tone="default"
                          agent={`source-toggle:${source.actionId}`}
                          disabled={source.pending}
                          onPress={dispatch(`source-toggle:${source.actionId}`)}
                        >
                          {source.pending
                            ? source.included
                              ? "Excluding…"
                              : "Including…"
                            : source.included
                              ? "Exclude"
                              : "Include"}
                        </Button>
                      ) : (
                        <Text style="caption" tone="muted">
                          Inclusion unavailable
                        </Text>
                      )}
                    </HStack>
                    <Text style="caption" tone={source.tone}>
                      {source.accessLabel} · {source.visibilityLabel} ·{" "}
                      {source.statusLabel} · {source.freshnessLabel}
                    </Text>
                    {source.mutationError ? (
                      <Text style="caption" tone="danger">
                        {source.mutationError}
                      </Text>
                    ) : null}
                    {source.reconnectConnectorId ? (
                      <Button
                        variant="ghost"
                        tone="default"
                        agent={`source-reconnect:${source.actionId}`}
                        onPress={dispatch(
                          `source-reconnect:${source.actionId}`,
                        )}
                      >
                        Reconnect Google Calendar
                      </Button>
                    ) : source.reconnectUnavailable ? (
                      <Text style="caption" tone="muted">
                        Reconnect unavailable here.
                      </Text>
                    ) : null}
                  </VStack>
                ))}
              </List>
            ) : null}

            {snapshot.sourceManager.rows.length > 0 ? (
              <Button
                variant="ghost"
                tone="default"
                agent="source-refresh"
                disabled={snapshot.sourceManager.refreshing}
                onPress={dispatch("source-refresh")}
              >
                {snapshot.sourceManager.refreshing
                  ? "Refreshing sources…"
                  : "Refresh sources"}
              </Button>
            ) : null}
          </>
        ) : null}
      </VStack>

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
    const emptyLabel = {
      loading: "Loading",
      empty: "No events in this range",
      ready: "No events in this range",
      partial: "No events from available sources",
      unavailable: "Calendar unavailable",
      error: "Calendar could not load",
    }[snapshot.status];
    return (
      <Text tone="muted" align="center" style="caption">
        {emptyLabel}
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
