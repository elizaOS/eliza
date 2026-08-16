/**
 * Deterministic coverage for unread-notification pagination before priority
 * ranking, using a structural GitHub activity client with multiple pages.
 */
import { logger } from "@elizaos/core";
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

    const notifications = await fetchAllUnreadNotifications(activity);

    expect(notifications).toHaveLength(60);
    expect(new Set(notifications.map((n) => n.id)).size).toBe(60);
  });

  it("stops after the page cap instead of looping on an always-full inbox", async () => {
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const page = (start: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        id: String(start + index),
        updated_at: "2026-08-16T00:00:00Z",
      }));
    const listNotificationsForAuthenticatedUser = vi
      .fn()
      .mockImplementation(async ({ page: pageNumber }: { page: number }) => ({
        data: page((pageNumber - 1) * 50),
      }));
    const activity = {
      listNotificationsForAuthenticatedUser,
    } as GitHubOctokitClient["activity"];

    const notifications = await fetchAllUnreadNotifications(activity);

    expect(listNotificationsForAuthenticatedUser).toHaveBeenCalledTimes(20);
    expect(notifications).toHaveLength(1000);
    expect(warning).toHaveBeenCalledWith(
      { pages: 20, collected: 1000 },
      "[GitHub:GITHUB_NOTIFICATION_TRIAGE] unread notifications truncated at page cap",
    );
    warning.mockRestore();
  });
});
