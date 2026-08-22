/**
 * Pins the compat room-key scoping invariant: keys within the historical
 * 120-char limit keep their exact derivation, and longer keys never alias two
 * distinct conversations onto one room the way the previous bare
 * `.slice(0, 120)` did.
 */

import { stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  COMPAT_ROOM_KEY_MAX_LENGTH,
  resolveCompatRoomKey,
  scopeCompatRoomKey,
} from "./compat-utils.ts";

function roomUuid(principalScopedRoomKey: string): UUID {
  return stringToUuid(`Eliza-openai-room-${principalScopedRoomKey}`) as UUID;
}

describe("scopeCompatRoomKey", () => {
  it("keeps short keys byte-identical to the historical truncation-free path", () => {
    for (const key of [
      "default",
      "user_12345",
      "a".repeat(119),
      "b".repeat(120),
    ]) {
      expect(scopeCompatRoomKey(key)).toBe(key);
    }
  });

  it("derives distinct rooms for distinct long keys sharing a 120-char prefix", () => {
    const prefix = "conversation:org-acme:service=relay:".padEnd(120, "x");
    const first = `${prefix}00000000-0000-4000-8000-000000000001`;
    const second = `${prefix}00000000-0000-4000-8000-000000000002`;
    expect(first.length).toBeGreaterThan(COMPAT_ROOM_KEY_MAX_LENGTH);
    expect(first.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH)).toBe(
      second.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH),
    );

    const scopedFirst = scopeCompatRoomKey(first);
    const scopedSecond = scopeCompatRoomKey(second);
    expect(scopedFirst).not.toBe(scopedSecond);
    expect(roomUuid(scopedFirst)).not.toBe(roomUuid(scopedSecond));

    // The old behavior aliased both onto one room — the defect.
    expect(roomUuid(first.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH))).toBe(
      roomUuid(second.slice(0, COMPAT_ROOM_KEY_MAX_LENGTH)),
    );
  });

  it("is deterministic for the same long key across requests", () => {
    const key = "k".repeat(300);
    expect(scopeCompatRoomKey(key)).toBe(scopeCompatRoomKey(key));
  });
});

describe("resolveCompatRoomKey", () => {
  it("resolves user and metadata identifiers used by compat clients", () => {
    expect(resolveCompatRoomKey({ user: "u-1" })).toBe("u-1");
    expect(resolveCompatRoomKey({ metadata: { conversation_id: "c-2" } })).toBe(
      "c-2",
    );
    expect(resolveCompatRoomKey({ metadata: { user_id: "v-3" } })).toBe("v-3");
    expect(resolveCompatRoomKey({})).toBe("default");
  });
});
