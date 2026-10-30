/** Reversible Calendar-owned model-wire encoding; canonical data/receipts stay intact. */
import type { ActionResult } from "@elizaos/core";
export function calendarReadPromptProjection(
  data: ActionResult["data"],
): Pick<ActionResult, "promptData" | "promptDataMode"> {
  if (!data || !Array.isArray(data.events) || data.events.length < 2) return {};
  try {
    // Encode the JSON the model wire and recordings carry. An own property
    // holding undefined (the feed's accountEmail for a source without one) is
    // absent there; on the live object it disabled this encoding for every
    // aggregated feed.
    const wire = JSON.parse(JSON.stringify(data)) as typeof data;
    const events = wire.events as Record<string, unknown>[];
    const first = events[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return {};
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
        return {};
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
      return {};
    return { promptData, promptDataMode: "replace-data" };
  } catch {
    return {};
  }
}
