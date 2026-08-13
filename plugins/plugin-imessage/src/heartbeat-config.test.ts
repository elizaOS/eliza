/**
 * Verifies operator heartbeat configuration before it reaches recurring task scheduling.
 */

import { describe, expect, it } from "vitest";
import { resolveHeartbeatIntervalMs } from "./service";

describe("resolveHeartbeatIntervalMs", () => {
  it("uses the default when the setting is absent or blank", () => {
    expect(resolveHeartbeatIntervalMs(undefined)).toBe(60_000);
    expect(resolveHeartbeatIntervalMs("  ")).toBe(60_000);
  });

  it("accepts positive integer millisecond intervals", () => {
    expect(resolveHeartbeatIntervalMs(" 5000 ")).toBe(5_000);
    expect(resolveHeartbeatIntervalMs("2147483647")).toBe(2_147_483_647);
  });

  it.each(["0", "-1", "1.5", "1e3", "5000oops", "Infinity", "2147483648"])(
    "rejects invalid operator input %s",
    (raw) => {
      expect(() => resolveHeartbeatIntervalMs(raw)).toThrow(/IMESSAGE_HEARTBEAT_INTERVAL_MS/);
    }
  );
});
