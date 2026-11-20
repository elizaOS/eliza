import { afterAll, beforeAll, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.js";
import { calendarPlugin } from "../src/plugin.ts";
import { CalendarService } from "../src/service/index.js";

const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const DAY = "2026-08-09T";

let fixture: Awaited<ReturnType<typeof createRealTestRuntime>>;
let calendar: CalendarService;

beforeAll(async () => {
  fixture = await createRealTestRuntime({
    characterName: "TravelBufferMove",
    plugins: [calendarPlugin],
  });
  const service = fixture.runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!service) throw Error("The production Calendar service did not start");
  calendar = service;
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
});

it.each([
  [
    "a later start",
    30,
    { startAt: "17:00", endAt: "18:00" },
    ["16:30", "17:00"],
  ],
  [
    "an earlier start",
    45,
    { startAt: "12:00", endAt: "13:00" },
    ["11:15", "12:00"],
  ],
  [
    "a title-only edit",
    30,
    { title: "Dentist (moved room)" },
    ["14:30", "15:00"],
  ],
] as const)(
  "keeps the travel buffer before the event after %s",
  async (name, bufferMinutes, patch, expected) => {
    const created = await calendar.createCalendarEventMutation(INTERNAL_URL, {
      title: `Dentist ${name}`,
      startAt: `${DAY}15:00:00.000Z`,
      endAt: `${DAY}16:00:00.000Z`,
      timeZone: "UTC",
      idempotencyKey: `travel-buffer-move:${name}`,
    });
    if (!created.event) throw Error("The built-in event was not persisted");
    await calendar.reserveTravelBuffer({
      eventId: created.event.id,
      bufferMinutes,
      method: "driving",
    });

    await calendar.updateCalendarEvent(INTERNAL_URL, {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      eventId: created.event.externalId,
      expectedProviderVersion: String(created.event.metadata.etag),
      timeZone: "UTC",
      ...("title" in patch
        ? { title: patch.title }
        : {
            startAt: `${DAY}${patch.startAt}:00.000Z`,
            endAt: `${DAY}${patch.endAt}:00.000Z`,
          }),
    });

    const feed = await calendar.getCalendarFeed(INTERNAL_URL, {
      timeMin: `${DAY}00:00:00.000Z`,
      timeMax: "2026-08-10T00:00:00.000Z",
    });
    const travel = feed.events.filter(
      (event) =>
        event.metadata.availabilityKind === "travel" &&
        event.metadata.parentEventId === created.event?.id,
    );
    expect(travel.map((event) => [event.startAt, event.endAt])).toEqual([
      [`${DAY}${expected[0]}:00.000Z`, `${DAY}${expected[1]}:00.000Z`],
    ]);
  },
  60_000,
);
