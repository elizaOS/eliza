/**
 * Deterministic coverage for unread-notification pagination before priority
 * ranking, using a structural GitHub activity client with multiple pages.
 */
import { describe, expect, it, vi } from "vitest";
import type { GitHubOctokitClient } from "../types.js";
import {
  fetchAllUnreadNotifications,
  formatTriageSummary,
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
});
