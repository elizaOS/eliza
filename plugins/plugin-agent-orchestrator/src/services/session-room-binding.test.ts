/**
 * Unit tests for session room binding: validates origin room resolution ladder.
 */

import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  resolveOriginRoomId,
  sessionBoundRoomIds,
} from "./session-room-binding.ts";

describe("session-room-binding", () => {
  const uuid1 = "11111111-1111-1111-1111-111111111111" as UUID;
  const uuid2 = "22222222-2222-2222-2222-222222222222" as UUID;

  it("returns undefined when metadata is empty or undefined", () => {
    expect(resolveOriginRoomId(undefined)).toBeUndefined();
    expect(resolveOriginRoomId({})).toBeUndefined();
  });

  it("resolves origin room following priority ladder", () => {
    expect(
      resolveOriginRoomId({
        originRoomId: uuid1,
        sourceRoomId: uuid2,
      }),
    ).toBe(uuid1);

    expect(
      resolveOriginRoomId({
        sourceRoomId: uuid2,
      }),
    ).toBe(uuid2);
  });

  it("collects all distinct bound room ids from metadata", () => {
    const rooms = sessionBoundRoomIds({
      roomId: uuid1,
      originRoomId: uuid2,
      taskRoomId: uuid1,
    });
    expect(rooms.size).toBe(2);
    expect(rooms.has(uuid1)).toBe(true);
    expect(rooms.has(uuid2)).toBe(true);
  });
});
