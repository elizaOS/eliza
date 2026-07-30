/**
 * Two provider-contract edges against deterministic Google API stubs: 403
 * usageLimits reason codes must stay retryable transport failures (never a
 * definitive "mutation rejected" 422), and events.list ordering must be
 * strictly opt-in because orderBy suppresses nextSyncToken and would silently
 * kill incremental sync.
 */
import type { calendar_v3 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient, GoogleCalendarMutationError } from "./calendar";
import type { GoogleApiClientFactory } from "./client-factory";

function clientFor(calendar: object): GoogleCalendarClient {
  const factory = {
    calendar: vi.fn(async () => calendar),
  } as unknown as GoogleApiClientFactory;
  return new GoogleCalendarClient(factory);
}

function quotaError(reason: string): Error {
  const error = new Error(`Google 403 ${reason}`);
  Object.assign(error, {
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          message: reason,
          errors: [{ reason, domain: "usageLimits", message: reason }],
        },
      },
    },
  });
  return error;
}

const CREATE_PARAMS = {
  accountId: "acct-1",
  title: "Standup",
  start: "2026-08-01T09:00:00.000Z",
  end: "2026-08-01T09:15:00.000Z",
  timeZone: "UTC",
};

describe("403 usageLimits classification", () => {
  it.each(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"])(
    "surfaces the original %s error instead of a definitive mutation rejection",
    async (reason) => {
      const error = quotaError(reason);
      const client = clientFor({
        events: { insert: vi.fn(async () => Promise.reject(error)) },
      });
      await expect(client.createEvent(CREATE_PARAMS)).rejects.toBe(error);
    }
  );

  it("reads reason codes from the top-level errors array too", async () => {
    const error = new Error("Google 403 rateLimitExceeded");
    Object.assign(error, {
      status: 403,
      errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }],
    });
    const client = clientFor({
      events: { insert: vi.fn(async () => Promise.reject(error)) },
    });
    await expect(client.createEvent(CREATE_PARAMS)).rejects.toBe(error);
  });

  it("keeps a 403 without a quota reason as a definitive rejection", async () => {
    const error = new Error("Google 403 forbidden");
    Object.assign(error, {
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "forbidden",
            errors: [{ reason: "forbidden", domain: "global" }],
          },
        },
      },
    });
    const client = clientFor({
      events: { insert: vi.fn(async () => Promise.reject(error)) },
    });
    await expect(client.createEvent(CREATE_PARAMS)).rejects.toMatchObject<
      Partial<GoogleCalendarMutationError>
    >({
      outcome: "not_accepted",
      code: "GOOGLE_CALENDAR_MUTATION_NOT_ACCEPTED",
    });
    await expect(client.createEvent(CREATE_PARAMS)).rejects.toBeInstanceOf(
      GoogleCalendarMutationError
    );
  });

  it("keeps quota classification for delete mutations as well", async () => {
    const error = quotaError("userRateLimitExceeded");
    const client = clientFor({
      events: { delete: vi.fn(async () => Promise.reject(error)) },
    });
    await expect(client.deleteEvent({ accountId: "acct-1", eventId: "event-1" })).rejects.toBe(
      error
    );
  });
});

describe("events.list ordering is opt-in", () => {
  function listStub(): {
    list: ReturnType<typeof vi.fn>;
    requests: calendar_v3.Params$Resource$Events$List[];
  } {
    const requests: calendar_v3.Params$Resource$Events$List[] = [];
    const list = vi.fn(async (request: calendar_v3.Params$Resource$Events$List) => {
      requests.push(request);
      return { data: { items: [], nextSyncToken: "sync-1" } };
    });
    return { list, requests };
  }

  it("omits orderBy by default so full drains still receive nextSyncToken", async () => {
    const { list, requests } = listStub();
    const client = clientFor({ events: { list } });
    const page = await client.listEventPage({
      accountId: "acct-1",
      timeMin: "2026-08-01T00:00:00.000Z",
      timeMax: "2026-08-02T00:00:00.000Z",
    });
    expect(requests[0]).not.toHaveProperty("orderBy");
    expect(page.nextSyncToken).toBe("sync-1");
  });

  it("omits orderBy on incremental sync requests", async () => {
    const { list, requests } = listStub();
    const client = clientFor({ events: { list } });
    await client.listEventPage({ accountId: "acct-1", syncToken: "sync-0" });
    expect(requests[0]).not.toHaveProperty("orderBy");
    expect(requests[0]).toMatchObject({ syncToken: "sync-0", showDeleted: true });
  });

  it("passes orderBy through when a display caller opts in", async () => {
    const { list, requests } = listStub();
    const client = clientFor({ events: { list } });
    await client.listEventPage({ accountId: "acct-1", orderBy: "startTime" });
    expect(requests[0]).toMatchObject({ orderBy: "startTime", singleEvents: true });
  });

  it("rejects syncToken combined with orderBy before touching the API", async () => {
    const { list } = listStub();
    const client = clientFor({ events: { list } });
    await expect(
      client.listEventPage({
        accountId: "acct-1",
        syncToken: "sync-0",
        orderBy: "startTime",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_CALENDAR_INVALID_REQUEST" });
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps chronological ordering on the display-oriented listEvents adapter", async () => {
    const { list, requests } = listStub();
    const client = clientFor({ events: { list } });
    await client.listEvents({ accountId: "acct-1" });
    expect(requests[0]).toMatchObject({ orderBy: "startTime" });
  });
});
