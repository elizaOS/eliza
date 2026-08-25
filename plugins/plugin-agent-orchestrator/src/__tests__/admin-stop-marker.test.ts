/**
 * Deterministic tests for the administrative-stop marker: the stamp merges the
 * canonical reason and stamped-at keys via updateSessionMetadata, tolerates
 * services without the method, never throws when the stamp fails (fail-open
 * toward the never-silent-terminal invariant — the stop must proceed
 * regardless), and the freshness predicate treats missing, unparseable, and
 * beyond-TTL timestamps as stale.
 */
import { describe, expect, test } from "vitest";
import {
  ADMIN_STOP_MARKER_TTL_MS,
  ADMIN_STOP_META_KEY,
  ADMIN_STOP_STAMPED_AT_META_KEY,
  isAdminStopMarkerCurrent,
  markSessionAdministrativelyStopped,
} from "../services/admin-stop-marker";

describe("markSessionAdministrativelyStopped", () => {
  test("stamps the reason and a parseable stamped-at instant together", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    const before = Date.now();
    await markSessionAdministrativelyStopped(
      {
        updateSessionMetadata: async (id, patch) => {
          patches.push([id, patch]);
        },
      },
      "sess-1",
      "user_stop",
    );
    const after = Date.now();
    expect(patches.length).toBe(1);
    const [id, patch] = patches[0] as [string, Record<string, unknown>];
    expect(id).toBe("sess-1");
    expect(patch[ADMIN_STOP_META_KEY]).toBe("user_stop");
    const stampedMs = Date.parse(String(patch[ADMIN_STOP_STAMPED_AT_META_KEY]));
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(after);
  });

  test("is a no-op for services without updateSessionMetadata", async () => {
    await markSessionAdministrativelyStopped({}, "sess-2", "task_lifecycle");
  });

  test("never throws when the stamp fails, and reports through the logger", async () => {
    const logged: string[] = [];
    await markSessionAdministrativelyStopped(
      {
        updateSessionMetadata: async () => {
          throw new Error("store gone");
        },
      },
      "sess-3",
      "idle_reclaim",
      (msg) => logged.push(msg),
    );
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("sess-3");
    expect(logged[0]).toContain("store gone");
  });
});

describe("isAdminStopMarkerCurrent", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  test("honors a stamp inside the freshness window, including the boundary", () => {
    expect(
      isAdminStopMarkerCurrent(new Date(now - 1_000).toISOString(), now),
    ).toBe(true);
    expect(
      isAdminStopMarkerCurrent(
        new Date(now - ADMIN_STOP_MARKER_TTL_MS).toISOString(),
        now,
      ),
    ).toBe(true);
  });

  test("treats a stamp past the window as stale", () => {
    expect(
      isAdminStopMarkerCurrent(
        new Date(now - ADMIN_STOP_MARKER_TTL_MS - 1).toISOString(),
        now,
      ),
    ).toBe(false);
  });

  test("treats missing and unparseable timestamps as stale (pre-#22981 stamps)", () => {
    expect(isAdminStopMarkerCurrent(undefined, now)).toBe(false);
    expect(isAdminStopMarkerCurrent("not-a-date", now)).toBe(false);
  });
});
