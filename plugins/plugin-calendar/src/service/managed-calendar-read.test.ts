/** Managed feed reads over a scripted private host with the real body cap. */
import { describe, expect, it } from "vitest";
import {
  createManagedCalendarRead,
  MANAGED_CALENDAR_RANGE_TOO_LARGE,
  managedCalendarReadDiagnostic,
  managedCalendarRefusal,
} from "./managed-calendar-read.js";

const grantId = `alpha-google:${"a".repeat(64)}`;
const calendar = {
  provider: "google",
  side: "owner",
  grantId,
  connectorAccountId: grantId,
  calendarId: "primary",
  summary: "Owner",
  accessRole: "owner",
} as never;
const DAY = 24 * 60 * 60 * 1000;

function host(maxDays: number, refuse = false) {
  const windows: string[] = [];
  // One event per day, plus a three-day event that crosses every split.
  const events = Array.from({ length: 30 }, (_, day) => ({
    id: `${grantId}:day-${day}`,
    start: Date.parse("2026-11-01T00:00:00.000Z") + day * DAY + 9 * 3600_000,
    hours: 1,
  }));
  events.push({
    id: `${grantId}:offsite`,
    start: Date.parse("2026-11-13T00:00:00.000Z"),
    hours: 72,
  });
  const request = (async (_url, init) => {
    const { timeMin, timeMax } = JSON.parse(String(init?.body)).calendar;
    windows.push(`${timeMin}/${timeMax}`);
    if (Date.parse(timeMax) - Date.parse(timeMin) > maxDays * DAY)
      return refuse
        ? Response.json({ reason: "result-too-large" }, { status: 409 })
        : new Response("x".repeat(256 * 1024 + 1));
    const rows = events
      .filter(
        (e) =>
          e.start < Date.parse(timeMax) &&
          e.start + e.hours * 3600_000 > Date.parse(timeMin),
      )
      .map((e) => ({
        id: e.id,
        externalId: e.id.split(":").at(-1),
        provider: "google",
        side: "owner",
        grantId,
        calendarId: "primary",
        title: e.id,
        startAt: new Date(e.start).toISOString(),
        endAt: new Date(e.start + e.hours * 3600_000).toISOString(),
      }));
    return Response.json({
      feed: {
        calendarId: "primary",
        state: "complete",
        source: "synced",
        timeMin,
        timeMax,
        events: rows,
        sources: [
          {
            key: {
              grantId,
              calendarId: "primary",
              side: "owner",
              provider: "google",
            },
            status: "fresh",
          },
        ],
        syncedAt: "2026-11-08T00:00:00.000Z",
      },
    });
  }) as typeof fetch;
  const reader = createManagedCalendarRead(
    {
      ELIZA_MANAGED_CALENDAR_READ_BROKER:
        "http://127.0.0.1:1/__alpha-owner-gmail",
      ELIZA_API_TOKEN: "a".repeat(64),
    },
    request,
  );
  if (!reader) throw Error("Missing managed reader");
  return { reader, windows };
}

describe("managed Calendar feed body limit", () => {
  it("splits an oversized month into weeks and merges without duplicates", async () => {
    const { reader, windows } = host(7);
    const feed = await reader.feed(
      calendar,
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      "UTC",
      "agent",
    );
    expect(feed.timeMin).toBe("2026-11-01T00:00:00.000Z");
    expect(feed.timeMax).toBe("2026-12-01T00:00:00.000Z");
    const ids = feed.events.map((e) => e.id);
    expect(ids).toHaveLength(31);
    expect(new Set(ids).size).toBe(31);
    expect(ids).toContain(`${grantId}:offsite`);
    expect(feed.events.every((e) => e.agentId === "agent")).toBe(true);
    expect(
      feed.events.every(
        (e, i, all) => i === 0 || all[i - 1].startAt <= e.startAt,
      ),
    ).toBe(true);
    expect(windows.length).toBeGreaterThan(1);
  });

  it("reports the source unavailable when a one-day slice still exceeds the cap", async () => {
    const { reader, windows } = host(0);
    let failure: unknown;
    try {
      await reader.feed(
        calendar,
        "2026-11-01T00:00:00.000Z",
        "2026-11-05T00:00:00.000Z",
        "UTC",
        "agent",
      );
    } catch (error) {
      failure = error;
    }
    expect(managedCalendarReadDiagnostic(failure)?.code).toBe("BODY_LIMIT");
    // 4 days -> 2 days -> 1 day: the first one-day slice ends the read.
    expect(windows).toHaveLength(3);
  });
});

describe("managed Calendar host refusals", () => {
  it("splits a range the host refuses as too large", async () => {
    const { reader, windows } = host(7, true);
    const feed = await reader.feed(
      calendar,
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      "UTC",
      "agent",
    );
    expect(feed.events).toHaveLength(31);
    expect(windows.length).toBeGreaterThan(1);
  });

  it("asks for a narrower range when a one-day slice is still too large", async () => {
    const { reader } = host(0, true);
    const failure = await reader
      .feed(
        calendar,
        "2026-11-01T00:00:00.000Z",
        "2026-11-05T00:00:00.000Z",
        "UTC",
        "agent",
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: MANAGED_CALENDAR_RANGE_TOO_LARGE,
      severity: "fatal",
    });
    expect(String((failure as Error).message)).toContain("Narrow the range");
    expect(managedCalendarReadDiagnostic(failure)).toBeUndefined();
  });

  it.each([
    [{ reason: "changes-off" }, "changes-off"],
    [{ reason: "request-too-large" }, "request-too-large"],
    [{ reason: "signed-out" }, undefined],
    [{ error: "Google request could not be verified." }, undefined],
  ])("keeps only a known reason on the refusal %j", async (body, reason) => {
    const reader = createManagedCalendarRead(
      {
        ELIZA_MANAGED_CALENDAR_READ_BROKER:
          "http://127.0.0.1:1/__alpha-owner-gmail",
        ELIZA_API_TOKEN: "a".repeat(64),
      },
      (async () => Response.json(body, { status: 409 })) as typeof fetch,
    );
    const failure = await reader
      ?.mutation({ operation: "write-execute" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "MANAGED_CALENDAR_READ_UNAVAILABLE",
    });
    expect(managedCalendarRefusal(failure)).toBe(reason);
  });
});
