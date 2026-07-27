// @vitest-environment jsdom

/**
 * Exercises calendar source discovery and writes against a deterministic
 * client, including stale-list and overlapping-write races across accounts.
 */

import type { LifeOpsCalendarSummary } from "@elizaos/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uiClient = vi.hoisted(() => ({
  getLifeOpsCalendars: vi.fn(),
  setLifeOpsCalendarIncluded: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  client: uiClient,
}));

vi.mock("@elizaos/ui/api", () => ({
  client: uiClient,
  ElizaClient: class {
    fetch = vi.fn(async () => ({}));
  },
}));

import { calendarSourceIdentityKey } from "../components/calendar/source-manager.js";
import { useCalendarSources } from "./useCalendarSources.js";

function calendar(
  over: Partial<LifeOpsCalendarSummary> = {},
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: "owner",
    grantId: "grant-work",
    connectorAccountId: "account-work",
    accountEmail: "work@example.com",
    calendarId: "primary",
    summary: "Work",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
    ...over,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useCalendarSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiClient.getLifeOpsCalendars.mockResolvedValue({
      calendars: [calendar()],
    });
    uiClient.setLifeOpsCalendarIncluded.mockImplementation(
      async (request: {
        calendarId: string;
        includeInFeed: boolean;
        side: string;
        grantId: string;
      }) => ({
        calendar: calendar({
          calendarId: request.calendarId,
          includeInFeed: request.includeInFeed,
          side: request.side,
          grantId: request.grantId,
        }),
      }),
    );
  });

  it("loads owner calendars and distinguishes loading, ready, empty, and error", async () => {
    const initial = deferred<{ calendars: LifeOpsCalendarSummary[] }>();
    uiClient.getLifeOpsCalendars.mockReturnValueOnce(initial.promise);
    const { result, unmount } = renderHook(() => useCalendarSources());

    expect(result.current.status).toBe("loading");
    expect(result.current.loading).toBe(true);
    expect(uiClient.getLifeOpsCalendars).toHaveBeenCalledWith({
      side: "owner",
    });

    await act(async () => {
      initial.resolve({ calendars: [calendar()] });
      await initial.promise;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.calendars[0]?.accountEmail).toBe("work@example.com");
    unmount();

    uiClient.getLifeOpsCalendars.mockResolvedValueOnce({ calendars: [] });
    const empty = renderHook(() => useCalendarSources());
    await waitFor(() => expect(empty.result.current.status).toBe("empty"));
    empty.unmount();

    uiClient.getLifeOpsCalendars.mockRejectedValueOnce(
      new Error("private upstream detail"),
    );
    const failed = renderHook(() => useCalendarSources());
    await waitFor(() => expect(failed.result.current.status).toBe("error"));
    expect(failed.result.current.error).toBe(
      "Calendar sources could not load.",
    );
    expect(failed.result.current.calendars).toEqual([]);
    failed.unmount();
  });

  it("keeps existing settings visible when a refresh fails", async () => {
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    uiClient.getLifeOpsCalendars.mockRejectedValueOnce(
      new Error("refresh failed"),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.calendars[0]?.includeInFeed).toBe(true);
    expect(result.current.refreshError).toContain(
      "Existing settings are still shown",
    );
    expect(result.current.refreshing).toBe(false);
  });

  it("waits for the authoritative write response before changing inclusion", async () => {
    const write = deferred<{ calendar: LifeOpsCalendarSummary }>();
    uiClient.setLifeOpsCalendarIncluded.mockReturnValueOnce(write.promise);
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const original = result.current.calendars[0];
    const key = calendarSourceIdentityKey(original);
    let outcome: string | undefined;

    act(() => {
      void result.current.setIncluded(original, false).then((value) => {
        outcome = value;
      });
    });

    await waitFor(() => expect(result.current.pendingKeys.has(key)).toBe(true));
    expect(result.current.calendars[0]?.includeInFeed).toBe(true);
    expect(uiClient.setLifeOpsCalendarIncluded).toHaveBeenCalledWith({
      calendarId: "primary",
      includeInFeed: false,
      side: "owner",
      grantId: "grant-work",
    });

    await act(async () => {
      write.resolve({
        calendar: calendar({ includeInFeed: false }),
      });
      await write.promise;
    });

    expect(outcome).toBe("updated");
    expect(result.current.pendingKeys.has(key)).toBe(false);
    expect(result.current.calendars[0]?.includeInFeed).toBe(false);
  });

  it("preserves the prior state and shows a privacy-safe row error on failure", async () => {
    uiClient.setLifeOpsCalendarIncluded.mockRejectedValueOnce(
      new Error("provider token and internal details"),
    );
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const original = result.current.calendars[0];
    const key = calendarSourceIdentityKey(original);
    let outcome: string | undefined;

    await act(async () => {
      outcome = await result.current.setIncluded(original, false);
    });

    expect(outcome).toBe("failed");
    expect(result.current.calendars[0]?.includeInFeed).toBe(true);
    expect(result.current.mutationErrors[key]).toBe(
      "Couldn’t exclude “Work”. Your current setting was kept.",
    );
    expect(result.current.mutationErrors[key]).not.toContain("token");
  });

  it("rejects a response for the wrong account or requested state", async () => {
    uiClient.setLifeOpsCalendarIncluded.mockResolvedValueOnce({
      calendar: calendar({
        grantId: "grant-other",
        connectorAccountId: "account-other",
        includeInFeed: false,
      }),
    });
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const original = result.current.calendars[0];

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.setIncluded(original, false);
    });

    expect(outcome).toBe("failed");
    expect(result.current.calendars[0]).toEqual(original);
  });

  it("ignores an older list response that resolves after the latest refresh", async () => {
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const older = deferred<{ calendars: LifeOpsCalendarSummary[] }>();
    const latest = deferred<{ calendars: LifeOpsCalendarSummary[] }>();
    uiClient.getLifeOpsCalendars
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);

    let olderPromise: Promise<void> | undefined;
    let latestPromise: Promise<void> | undefined;
    act(() => {
      olderPromise = result.current.refresh();
      latestPromise = result.current.refresh();
    });

    await act(async () => {
      latest.resolve({
        calendars: [calendar({ summary: "Latest", includeInFeed: false })],
      });
      await latestPromise;
    });
    expect(result.current.calendars[0]?.summary).toBe("Latest");

    await act(async () => {
      older.resolve({ calendars: [calendar({ summary: "Older" })] });
      await olderPromise;
    });
    expect(result.current.calendars[0]?.summary).toBe("Latest");
    expect(result.current.calendars[0]?.includeInFeed).toBe(false);
  });

  it("discards a list response that began before a preference write", async () => {
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const staleList = deferred<{ calendars: LifeOpsCalendarSummary[] }>();
    uiClient.getLifeOpsCalendars.mockReturnValueOnce(staleList.promise);

    let refreshPromise: Promise<void> | undefined;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(true));

    await act(async () => {
      await result.current.setIncluded(result.current.calendars[0], false);
    });
    expect(result.current.calendars[0]?.includeInFeed).toBe(false);

    await act(async () => {
      staleList.resolve({ calendars: [calendar({ includeInFeed: true })] });
      await refreshPromise;
    });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.calendars[0]?.includeInFeed).toBe(false);
  });

  it("lets the newest same-source write win when responses arrive out of order", async () => {
    const first = deferred<{ calendar: LifeOpsCalendarSummary }>();
    const second = deferred<{ calendar: LifeOpsCalendarSummary }>();
    uiClient.setLifeOpsCalendarIncluded
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const original = result.current.calendars[0];

    let firstOutcome: string | undefined;
    let secondOutcome: string | undefined;
    act(() => {
      void result.current.setIncluded(original, false).then((value) => {
        firstOutcome = value;
      });
      void result.current.setIncluded(original, true).then((value) => {
        secondOutcome = value;
      });
    });

    await act(async () => {
      second.resolve({ calendar: calendar({ includeInFeed: true }) });
      await second.promise;
    });
    expect(secondOutcome).toBe("updated");
    expect(result.current.calendars[0]?.includeInFeed).toBe(true);

    await act(async () => {
      first.resolve({ calendar: calendar({ includeInFeed: false }) });
      await first.promise;
    });
    expect(firstOutcome).toBe("superseded");
    expect(result.current.calendars[0]?.includeInFeed).toBe(true);
  });

  it("merges concurrent writes to different accounts without replacing either", async () => {
    const family = calendar({
      provider: "microsoft",
      grantId: "grant-family",
      connectorAccountId: "account-family",
      accountEmail: "family@example.com",
      calendarId: "family",
      summary: "Family",
      primary: false,
    });
    uiClient.getLifeOpsCalendars.mockResolvedValueOnce({
      calendars: [calendar(), family],
    });
    const workWrite = deferred<{ calendar: LifeOpsCalendarSummary }>();
    const familyWrite = deferred<{ calendar: LifeOpsCalendarSummary }>();
    uiClient.setLifeOpsCalendarIncluded
      .mockReturnValueOnce(workWrite.promise)
      .mockReturnValueOnce(familyWrite.promise);
    const { result } = renderHook(() => useCalendarSources());
    await waitFor(() => expect(result.current.calendars).toHaveLength(2));

    act(() => {
      void result.current.setIncluded(result.current.calendars[0], false);
      void result.current.setIncluded(result.current.calendars[1], false);
    });

    await act(async () => {
      familyWrite.resolve({
        calendar: { ...family, includeInFeed: false },
      });
      await familyWrite.promise;
      workWrite.resolve({
        calendar: calendar({ includeInFeed: false }),
      });
      await workWrite.promise;
    });

    expect(
      result.current.calendars.map((entry) => [
        entry.accountEmail,
        entry.includeInFeed,
      ]),
    ).toEqual([
      ["work@example.com", false],
      ["family@example.com", false],
    ]);
  });
});
