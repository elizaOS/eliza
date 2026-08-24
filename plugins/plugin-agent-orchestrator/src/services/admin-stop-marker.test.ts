/**
 * Unit tests for admin-stop-marker: validates marker freshness calculations.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_STOP_MARKER_TTL_MS,
  ADMIN_STOP_META_KEY,
  ADMIN_STOP_STAMPED_AT_META_KEY,
  isAdminStopMarkerCurrent,
} from "./admin-stop-marker.ts";

describe("admin-stop-marker", () => {
  it("exports metadata keys and TTL constant", () => {
    expect(ADMIN_STOP_META_KEY).toBe("adminStopReason");
    expect(ADMIN_STOP_STAMPED_AT_META_KEY).toBe("adminStopStampedAt");
    expect(ADMIN_STOP_MARKER_TTL_MS).toBe(10 * 60_000);
  });

  it("returns true for freshly stamped markers within TTL window", () => {
    const now = Date.now();
    const stampedAt = new Date(now - 5_000).toISOString();
    expect(isAdminStopMarkerCurrent(stampedAt, now)).toBe(true);
  });

  it("returns false for expired or missing timestamps", () => {
    const now = Date.now();
    expect(isAdminStopMarkerCurrent(undefined, now)).toBe(false);
    expect(isAdminStopMarkerCurrent("invalid-date", now)).toBe(false);

    const expired = new Date(now - 15 * 60_000).toISOString();
    expect(isAdminStopMarkerCurrent(expired, now)).toBe(false);
  });
});
