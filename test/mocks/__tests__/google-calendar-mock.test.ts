import { afterEach, describe, expect, it } from "vitest";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

type CalendarListResponse = {
  items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
};

type CalendarEventResponse = {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
};

type CalendarEventsResponse = {
  items?: CalendarEventResponse[];
  nextPageToken?: string;
};

async function readJson<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as T;
}

async function googleToken(baseUrl: string, scope: string): Promise<string> {
  const response = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ scope }),
  });
  expect(response.status).toBe(200);
  const body = await readJson<{ access_token?: string }>(response);
  expect(body.access_token).toBeTruthy();
  return body.access_token ?? "";
}

describe("Google mock Calendar state", () => {
  let mocks: StartedMocks | null = null;

  afterEach(async () => {
    await mocks?.stop();
    mocks = null;
  });

  it("persists calendar list, search, create, patch, update, move, delete, and ledger state", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const calendars = await fetch(
      `${baseUrl}/calendar/v3/users/me/calendarList`,
    );
    expect(calendars.status).toBe(200);
    const calendarBody = await readJson<CalendarListResponse>(calendars);
    expect(calendarBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "primary",
          primary: true,
          summary: "Owner calendar",
        }),
      ]),
    );

    const start = "2026-05-04T16:00:00Z";
    const end = "2026-05-04T17:00:00Z";
    const createdResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Test-Run": "run-calendar-state",
        },
        body: JSON.stringify({
          summary: "Product review",
          description: "Review roadmap",
          location: "Room 3",
          start: { dateTime: start, timeZone: "America/Los_Angeles" },
          end: { dateTime: end, timeZone: "America/Los_Angeles" },
          attendees: [{ email: "sarah@example.com", displayName: "Sarah" }],
        }),
      },
    );
    expect(createdResponse.status).toBe(200);
    const created = await readJson<CalendarEventResponse>(createdResponse);
    expect(created.id?.startsWith("evt-")).toBe(true);

    const searchResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events?${new URLSearchParams({
        q: "roadmap Sarah",
        timeMin: "2026-05-04T00:00:00Z",
        timeMax: "2026-05-05T00:00:00Z",
      })}`,
    );
    expect(searchResponse.status).toBe(200);
    const searchBody = await readJson<CalendarEventsResponse>(searchResponse);
    expect(searchBody.items?.map((event) => event.id)).toEqual([created.id]);

    const patchedResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: "Room 4" }),
      },
    );
    expect(patchedResponse.status).toBe(200);
    expect(
      (await readJson<CalendarEventResponse>(patchedResponse)).location,
    ).toBe("Room 4");

    const updatedResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events/${created.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "Product review final",
          start: { dateTime: "2026-05-04T18:00:00Z" },
          end: { dateTime: "2026-05-04T19:00:00Z" },
        }),
      },
    );
    expect(updatedResponse.status).toBe(200);
    expect(
      (await readJson<CalendarEventResponse>(updatedResponse)).summary,
    ).toBe("Product review final");

    const movedResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events/${created.id}/move?destination=work`,
      { method: "POST" },
    );
    expect(movedResponse.status).toBe(200);
    expect(
      await fetch(
        `${baseUrl}/calendar/v3/calendars/primary/events/${created.id}`,
      ),
    ).toHaveProperty("status", 404);
    expect(
      await fetch(`${baseUrl}/calendar/v3/calendars/work/events/${created.id}`),
    ).toHaveProperty("status", 200);

    const deletedResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/work/events/${created.id}`,
      { method: "DELETE" },
    );
    expect(deletedResponse.status).toBe(204);

    const hiddenDeletedResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/work/events`,
    );
    expect(hiddenDeletedResponse.status).toBe(200);
    expect(
      (await readJson<CalendarEventsResponse>(hiddenDeletedResponse)).items,
    ).toEqual([]);

    const shownDeletedResponse = await fetch(
      `${baseUrl}/calendar/v3/calendars/work/events?showDeleted=true`,
    );
    expect(shownDeletedResponse.status).toBe(200);
    expect(
      (await readJson<CalendarEventsResponse>(shownDeletedResponse)).items?.[0],
    ).toEqual(expect.objectContaining({ id: created.id, status: "cancelled" }));

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-calendar-state",
          calendar: expect.objectContaining({
            action: "events.create",
            calendarId: "primary",
            runId: "run-calendar-state",
          }),
        }),
        expect.objectContaining({
          calendar: expect.objectContaining({
            action: "events.move",
            calendarId: "primary",
            destinationCalendarId: "work",
            eventId: created.id,
          }),
        }),
        expect.objectContaining({
          calendar: expect.objectContaining({
            action: "events.delete",
            calendarId: "work",
            eventId: created.id,
          }),
        }),
      ]),
    );
  });

  it("enforces calendar auth scopes and request body errors", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const unknownToken = await fetch(
      `${baseUrl}/calendar/v3/users/me/calendarList`,
      {
        headers: { Authorization: "Bearer not-known" },
      },
    );
    expect(unknownToken.status).toBe(401);

    const readonlyToken = await googleToken(
      baseUrl,
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    const allowedRead = await fetch(
      `${baseUrl}/calendar/v3/users/me/calendarList`,
      { headers: { Authorization: `Bearer ${readonlyToken}` } },
    );
    expect(allowedRead.status).toBe(200);

    const forbiddenWrite = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readonlyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: "Forbidden write",
          start: { dateTime: "2026-05-04T16:00:00Z" },
          end: { dateTime: "2026-05-04T17:00:00Z" },
        }),
      },
    );
    expect(forbiddenWrite.status).toBe(403);

    const malformedCreate = await fetch(
      `${baseUrl}/calendar/v3/calendars/primary/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "Missing end",
          start: { dateTime: "2026-05-04T16:00:00Z" },
        }),
      },
    );
    expect(malformedCreate.status).toBe(400);
  });
});
