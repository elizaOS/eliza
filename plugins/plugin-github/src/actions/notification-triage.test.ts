/**
 * Deterministic coverage for unread-notification pagination before priority
 * ranking, using a structural GitHub activity client with multiple pages.
 */
import { describe, expect, it, vi } from "vitest";
import type { GitHubOctokitClient } from "../types.js";
import { fetchAllUnreadNotifications } from "./notification-triage.js";

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

    const notifications = await fetchAllUnreadNotifications(activity);

    expect(notifications).toHaveLength(70);
    expect(notifications.at(-1)?.id).toBe("69");
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

    const notifications = await fetchAllUnreadNotifications(activity);

    expect(notifications).toEqual(fullPage);
    expect(listNotificationsForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});
