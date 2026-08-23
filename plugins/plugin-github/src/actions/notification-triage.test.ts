/**
 * Deterministic coverage for unread-notification pagination before priority
 * ranking, using a structural GitHub activity client with multiple pages.
 */
import { describe, expect, it, vi } from "vitest";
import type { GitHubOctokitClient } from "../types.js";
import {
  compareTriagedNotifications,
  fetchAllUnreadNotifications,
  formatTriageSummary,
  type TriagedNotification,
} from "./notification-triage.js";

describe("fetchAllUnreadNotifications", () => {
  it("collects later pages before reporting and ranking unread notifications", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      updated_at: "2026-08-16T00:00:00Z",
    }));
    const secondPage = Array.from({ length: 20 }, (_, index) => ({
      id: String(index + 50),
      updated_at: "2026-08-16T00:00:00Z",
    }));
    const listNotificationsForAuthenticatedUser = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: secondPage });
    const activity = {
      listNotificationsForAuthenticatedUser,
    } as GitHubOctokitClient["activity"];

    const result = await fetchAllUnreadNotifications(activity);

    expect(result.notifications).toHaveLength(70);
    expect(result.notifications.at(-1)?.id).toBe("69");
    expect(result.totalUnreadIsLowerBound).toBe(false);
    expect(listNotificationsForAuthenticatedUser).toHaveBeenNthCalledWith(1, {
      all: false,
      per_page: 50,
      page: 1,
    });
    expect(listNotificationsForAuthenticatedUser).toHaveBeenNthCalledWith(2, {
      all: false,
      per_page: 50,
      page: 2,
    });
  });

  it("requests the next page when the current page is exactly full", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      updated_at: "2026-08-16T00:00:00Z",
    }));
    const listNotificationsForAuthenticatedUser = vi
      .fn()
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({ data: [] });
    const activity = {
      listNotificationsForAuthenticatedUser,
    } as GitHubOctokitClient["activity"];

    const result = await fetchAllUnreadNotifications(activity);

    expect(result.notifications).toEqual(fullPage);
    expect(result.totalUnreadIsLowerBound).toBe(false);
    expect(listNotificationsForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it("drops re-served rows instead of double-counting them", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      updated_at: "2026-08-16T00:00:00Z",
    }));
    // A shifted window (inbox mutated mid-traversal) re-serves ids 40-49
    // from the first page alongside 10 genuinely new rows.
    const shiftedSecondPage = [
      ...firstPage.slice(40),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: String(index + 50),
        updated_at: "2026-08-16T00:00:00Z",
      })),
    ];
    const listNotificationsForAuthenticatedUser = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: shiftedSecondPage });
    const activity = {
      listNotificationsForAuthenticatedUser,
    } as GitHubOctokitClient["activity"];

    const result = await fetchAllUnreadNotifications(activity);

    expect(result.notifications).toHaveLength(60);
    expect(new Set(result.notifications.map((n) => n.id)).size).toBe(60);
    expect(result.totalUnreadIsLowerBound).toBe(false);
  });

  it("follows unread pages beyond the former fixed page ceiling", async () => {
    const page = (start: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        id: String(start + index),
        updated_at: "2026-08-16T00:00:00Z",
      }));
    const listNotificationsForAuthenticatedUser = vi
      .fn()
      .mockImplementation(async ({ page: pageNumber }: { page: number }) => ({
        data: pageNumber === 21 ? [] : page((pageNumber - 1) * 50),
      }));
    const activity = {
      listNotificationsForAuthenticatedUser,
    } as GitHubOctokitClient["activity"];

    const result = await fetchAllUnreadNotifications(activity);

    expect(listNotificationsForAuthenticatedUser).toHaveBeenCalledTimes(21);
    expect(result.notifications).toHaveLength(1000);
    expect(result.totalUnreadIsLowerBound).toBe(false);
  });
});

describe("formatTriageSummary", () => {
  it("keeps the established summary for a complete traversal", () => {
    expect(formatTriageSummary(7, 7, false)).toBe(
      "Triaged 7 unread notification(s)",
    );
  });

  it("makes a capped total visibly partial", () => {
    expect(formatTriageSummary(25, 1000, true)).toBe(
      "Triaged 25 of at least 1000 unread notification(s)",
    );
  });

  it("handles NaN scores safely when sorting triaged notifications", () => {
    const triaged = [
      {
        id: "n-1",
        reason: "mention",
        repo: "a/b",
        title: "t1",
        subjectType: "Issue",
        url: null,
        updatedAt: new Date().toISOString(),
        score: NaN,
      },
      {
        id: "n-2",
        reason: "mention",
        repo: "a/b",
        title: "t2",
        subjectType: "Issue",
        url: null,
        updatedAt: new Date().toISOString(),
        score: 100,
      },
    ];

    triaged.sort(compareTriagedNotifications);

    expect(triaged[0]?.id).toBe("n-2");
    expect(triaged[1]?.id).toBe("n-1");
  });

  it("tie-breaks equal scores by id deterministically", () => {
    const triaged = [
      {
        id: "z-id",
        reason: "mention",
        repo: "a/b",
        title: "t1",
        subjectType: "Issue",
        url: null,
        updatedAt: new Date().toISOString(),
        score: 10,
      },
      {
        id: "a-id",
        reason: "mention",
        repo: "a/b",
        title: "t2",
        subjectType: "Issue",
        url: null,
        updatedAt: new Date().toISOString(),
        score: 10,
      },
    ];

    triaged.sort(compareTriagedNotifications);

    expect(triaged[0]?.id).toBe("a-id");
    expect(triaged[1]?.id).toBe("z-id");
  });
});

describe("compareTriagedNotifications", () => {
  const base: Omit<TriagedNotification, "id" | "score"> = {
    reason: "mention",
    repo: "elizaOS/eliza",
    title: "(untitled)",
    subjectType: "Issue",
    url: null,
    updatedAt: "2026-08-16T00:00:00Z",
  };
  const at = (id: string, score: number): TriagedNotification => ({
    ...base,
    id,
    score,
  });

  it("orders the highest score first", () => {
    const triaged = [at("n-low", 10), at("n-high", 100)];
    triaged.sort(compareTriagedNotifications);
    expect(triaged.map((t) => t.id)).toEqual(["n-high", "n-low"]);
  });

  it("keeps a total order when a score is not finite", () => {
    const triaged = [at("n-nan", Number.NaN), at("n-scored", 100)];
    triaged.sort(compareTriagedNotifications);
    expect(triaged.map((t) => t.id)).toEqual(["n-scored", "n-nan"]);

    expect(
      compareTriagedNotifications(at("n-nan", Number.NaN), at("n-scored", 100)),
    ).toBeGreaterThan(0);
    expect(
      compareTriagedNotifications(at("n-scored", 100), at("n-nan", Number.NaN)),
    ).toBeLessThan(0);
  });

  it("tie-breaks equal scores on notification id", () => {
    expect(compareTriagedNotifications(at("b", 5), at("a", 5))).toBeGreaterThan(
      0,
    );
    expect(compareTriagedNotifications(at("a", 5), at("b", 5))).toBeLessThan(0);
  });
});
