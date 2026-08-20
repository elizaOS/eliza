/**
 * Deterministic tests for the administrative-stop marker: the stamp merges the
 * ONE canonical key via updateSessionMetadata, tolerates services without the
 * method, and never throws when the stamp fails (fail-open toward the
 * never-silent-terminal invariant — the stop must proceed regardless).
 */
import { describe, expect, test } from "bun:test";
import {
  ADMIN_STOP_META_KEY,
  markSessionAdministrativelyStopped,
} from "../services/admin-stop-marker";

describe("markSessionAdministrativelyStopped", () => {
  test("stamps the canonical key with the reason", async () => {
    const patches: Array<[string, Record<string, unknown>]> = [];
    await markSessionAdministrativelyStopped(
      {
        updateSessionMetadata: async (id, patch) => {
          patches.push([id, patch]);
        },
      },
      "sess-1",
      "user_stop",
    );
    expect(patches).toEqual([
      ["sess-1", { [ADMIN_STOP_META_KEY]: "user_stop" }],
    ]);
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
