import { promoteSubactionsToActions } from "@elizaos/core";
import { calendarAction as producer } from "@elizaos/plugin-calendar";
import { expect, it } from "vitest";
import { calendarAction } from "../src/actions/calendar.ts";

it("carries the calendar owner's exact observation contract through the wrapper and promoted operations", () => {
  expect(producer.historicalObservationOperations).toEqual([
    "calendar.event.next.read",
    "calendar.feed.read",
  ]);
  expect(calendarAction.historicalObservationOperations).toBe(
    producer.historicalObservationOperations,
  );
  const promoted = promoteSubactionsToActions(calendarAction);
  for (const name of ["CALENDAR_NEXT_EVENT", "CALENDAR_FEED"]) {
    const action = promoted.find((candidate) => candidate.name === name);
    expect(action).toBeDefined();
    expect(action?.historicalObservationOperations).toBe(
      calendarAction.historicalObservationOperations,
    );
  }
});
