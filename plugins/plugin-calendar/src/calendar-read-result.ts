/** Calendar model view and reversible event encoding; canonical data/receipts stay intact. */

import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import type {
  ActionResult,
  ProviderDataRecord,
  ProviderValue,
} from "@elizaos/core";
import { isValidTimeZone } from "./internal/constants.js";
import { formatCalendarEventTimeRange } from "./internal/format.js";
export function calendarReadPromptProjection(
  data: ActionResult["data"],
  options: { selectedEvent?: boolean } = {},
): Pick<ActionResult, "promptData" | "promptDataMode"> {
  if (!data) return {};
  // Source identities stay in canonical data for authorization, freshness,
  // routing and edits. The ordinary read model receives one Calendar view;
  // explicit source administration keeps its own complete result contract.
  const { sources, calendarSources, ...withoutSources } = data;
  const sourceInventory = Array.isArray(sources)
    ? sources
    : Array.isArray(calendarSources)
      ? calendarSources
      : undefined;
  const unified =
    sourceInventory !== undefined || options.selectedEvent === true;
  const rawReply = data.replyContext;
  const reply =
    rawReply && typeof rawReply === "object" && !Array.isArray(rawReply)
      ? (rawReply as ProviderDataRecord)
      : undefined;
  const context = reply?.context;
  const contextZone =
    context && typeof context === "object" && !Array.isArray(context)
      ? (context as ProviderDataRecord).timeZone
      : undefined;
  const nextClock = data.timeReference;
  const nextZone =
    nextClock && typeof nextClock === "object" && !Array.isArray(nextClock)
      ? (nextClock as ProviderDataRecord).timeZone
      : undefined;
  const displayZone =
    typeof contextZone === "string" && isValidTimeZone(contextZone)
      ? contextZone
      : typeof nextZone === "string" && isValidTimeZone(nextZone)
        ? nextZone
        : undefined;
  const modelEvent = (event: ProviderValue): ProviderValue => {
    if (!event || typeof event !== "object" || Array.isArray(event))
      return event;
    const {
      accountEmail: _accountEmail,
      calendarSummary: _calendarSummary,
      ...record
    } = event as ProviderDataRecord;
    // An exact selected-event read retains all authorized source context.
    // General aggregate reads keep their existing unified presentation.
    const selectedRecord = options.selectedEvent
      ? (event as ProviderDataRecord)
      : record;
    // Keep the canonical instants and source zone. Supply the already computed
    // local range as well, so a response never needs to guess the DST offset.
    return displayZone &&
      typeof selectedRecord.startAt === "string" &&
      typeof selectedRecord.endAt === "string" &&
      typeof selectedRecord.isAllDay === "boolean" &&
      Number.isFinite(Date.parse(selectedRecord.startAt)) &&
      Number.isFinite(Date.parse(selectedRecord.endAt))
      ? {
          ...selectedRecord,
          displayDate: new Intl.DateTimeFormat("en-US", {
            timeZone: selectedRecord.isAllDay ? "UTC" : displayZone,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          }).format(
            new Date(
              // All-day values retain their civil date, matching the existing
              // Calendar formatter, even when the source carries an offset.
              selectedRecord.isAllDay &&
                /^\d{4}-\d{2}-\d{2}/.test(selectedRecord.startAt)
                ? `${selectedRecord.startAt.slice(0, 10)}T00:00:00.000Z`
                : selectedRecord.startAt,
            ),
          ),
          displayTime: formatCalendarEventTimeRange(
            selectedRecord as unknown as LifeOpsCalendarEvent,
            {
              asOf: new Date(),
              timeZone: displayZone,
            },
          ),
        }
      : selectedRecord;
  };
  // Facts duplicate the structured events and can contain a legacy source
  // enumeration. Keep the actual scope/selection constraints, not that prose.
  const {
    facts: _facts,
    userFacingFacts: _userFacingFacts,
    ...replyScope
  } = reply ?? {};

  const view = unified
    ? {
        ...withoutSources,
        ...(Array.isArray(data.events)
          ? { events: data.events.map(modelEvent) }
          : {}),
        ...(data.event !== undefined ? { event: modelEvent(data.event) } : {}),
        ...(reply ? { replyContext: replyScope } : {}),
        calendarView: {
          name: "Calendar",
          state: data.state,
          sourceIssues: (sourceInventory ?? [])
            .filter(
              (source) =>
                source &&
                typeof source === "object" &&
                source.status !== "fresh",
            )
            .map((source) => ({
              status: source.status,
              visibility: source.visibility,
              errorCode:
                source.error && typeof source.error === "object"
                  ? source.error.code
                  : undefined,
            })),
          presentation:
            "This is one canonical Calendar with optional connected sync. Use each event’s computed displayDate and displayTime for weekday, date and local time. Describe its events and read coverage, not separate provider calendars. Event IDs and provenance fields are internal routing evidence, not additional user calendars. Preserve partial/unavailable status and the requested time-window boundary; never claim an incomplete view is empty.",
        },
      }
    : data;
  const fallback: Pick<ActionResult, "promptData" | "promptDataMode"> = unified
    ? { promptData: view, promptDataMode: "replace-data" }
    : {};
  if (!Array.isArray(view.events) || view.events.length < 2) return fallback;
  try {
    // Encode the JSON the model wire and recordings carry. An own property
    // holding undefined (the feed's accountEmail for a source without one) is
    // absent there; on the live object it disabled this encoding for every
    // aggregated feed.
    const wire = JSON.parse(JSON.stringify(view)) as typeof data;
    const events = wire.events as Record<string, unknown>[];
    const first = events[0];
    if (!first || typeof first !== "object" || Array.isArray(first))
      return fallback;
    const keys = Object.keys(first),
      rows: unknown[][] = [];
    const shared: Record<string, unknown> = {};
    for (const event of events) {
      if (
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        Object.keys(event).length !== keys.length ||
        Object.keys(event).some((key, index) => key !== keys[index])
      )
        return fallback;
    }
    for (const key of keys) {
      const encoded = JSON.stringify(first[key]);
      if (events.every((event) => JSON.stringify(event[key]) === encoded))
        shared[key] = first[key];
    }
    const columns = keys.filter((key) => !Object.hasOwn(shared, key));
    const prefixes: Record<string, string> = {};
    for (const key of columns) {
      if (!events.every((event) => typeof event[key] === "string")) continue;
      const chars = Array.from(first[key] as string);
      for (const event of events)
        while (
          chars.length &&
          !(event[key] as string).startsWith(chars.join(""))
        )
          chars.pop();
      const prefix = chars.join("");
      if (
        prefix &&
        Buffer.byteLength(prefix) * (events.length - 1) >
          Buffer.byteLength(JSON.stringify({ [key]: prefix })) + 8
      )
        prefixes[key] = prefix;
    }
    for (const event of events)
      rows.push(
        columns.map((key) =>
          Object.hasOwn(prefixes, key)
            ? (event[key] as string).slice(prefixes[key].length)
            : event[key],
        ),
      );
    const replyContext =
      wire.replyContext &&
      typeof wire.replyContext === "object" &&
      !Array.isArray(wire.replyContext)
        ? (wire.replyContext as Record<string, unknown>)
        : undefined;
    const projectedReplyContext =
      replyContext &&
      typeof replyContext.facts === "string" &&
      replyContext.userFacingFacts === replyContext.facts
        ? {
            ...replyContext,
            userFacingFacts: { sameValueAs: "replyContext.facts" },
          }
        : replyContext;
    const promptData = {
      ...wire,
      ...(projectedReplyContext ? { replyContext: projectedReplyContext } : {}),
      events: {
        format: "shared-fields-and-rows-v1",
        keys,
        shared,
        columns,
        prefixes,
        rows,
        interpretation:
          "All events. Rows map columns; prepend prefixes[column] to its cell when present. Add shared fields. keys gives original order. Every value/ID/timestamp is retained.",
      },
    };
    // Guard exact JSON reconstruction, including key order, before opting in.
    const restored = rows.map((row) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          Object.hasOwn(shared, key)
            ? shared[key]
            : Object.hasOwn(prefixes, key)
              ? prefixes[key] + row[columns.indexOf(key)]
              : row[columns.indexOf(key)],
        ]),
      ),
    );
    if (
      JSON.stringify(restored) !== JSON.stringify(events) ||
      Buffer.byteLength(JSON.stringify(promptData)) >=
        Buffer.byteLength(JSON.stringify(wire))
    )
      return fallback;
    return { promptData, promptDataMode: "replace-data" };
  } catch {
    return fallback;
  }
}
