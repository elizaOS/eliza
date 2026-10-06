/**
 * A last message at epoch is a real activity time. `getTime() || createdAt`
 * ranked that room by its later creation date and reported the wrong preview time.
 */

import { describe, expect, test } from "bun:test";
import { compareRoomsByActivity, roomPreviewActivityMs, roomSummaryMessageTime } from "./rooms";

describe("room preview activity", () => {
  test("keeps an epoch last message behind a later message from an older room", () => {
    const epochMessage = {
      lastMessageTime: new Date(0),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const laterMessage = {
      lastMessageTime: new Date("2024-01-01T00:00:00.000Z"),
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    };

    expect(roomPreviewActivityMs(epochMessage.lastMessageTime, epochMessage.createdAt)).toBe(0);
    expect(
      [epochMessage, laterMessage]
        .sort(compareRoomsByActivity)
        .map((room) => room.createdAt.toISOString()),
    ).toEqual(["2020-01-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"]);
  });

  test("keeps an epoch message time on the room summary", () => {
    expect(roomSummaryMessageTime(0, 1_700_000_000_000)).toBe(0);
    expect(roomSummaryMessageTime(undefined, 1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  test("falls back to creation time when the room has no last message", () => {
    const created = new Date("2024-06-01T00:00:00.000Z");
    expect(roomPreviewActivityMs(null, created)).toBe(created.getTime());
    expect(roomPreviewActivityMs(new Date(Number.NaN), created)).toBe(created.getTime());
  });
});
