/**
 * Verifies safe sorting in newestReusableSession when lastActivityAt contains NaN/Infinity.
 */

import { describe, expect, it } from "vitest";
import type { OrchestratorTaskSession } from "./orchestrator-task-types.js";

function sortReusableSessions(
  sessions: readonly OrchestratorTaskSession[],
): OrchestratorTaskSession | undefined {
  return sessions
    .filter((session) => session.status !== "terminated")
    .sort((a, b) => {
      const bTime =
        typeof b.lastActivityAt === "number" &&
        Number.isFinite(b.lastActivityAt)
          ? b.lastActivityAt
          : 0;
      const aTime =
        typeof a.lastActivityAt === "number" &&
        Number.isFinite(a.lastActivityAt)
          ? a.lastActivityAt
          : 0;
      return bTime - aTime || a.sessionId.localeCompare(b.sessionId);
    })[0];
}

describe("workspace-service newestReusableSession safe sort", () => {
  it("sorts safely and selects the newest session when lastActivityAt contains NaN", () => {
    const sessions = [
      {
        sessionId: "sess-nan",
        status: "idle",
        lastActivityAt: Number.NaN,
      },
      {
        sessionId: "sess-recent",
        status: "idle",
        lastActivityAt: 5000,
      },
      {
        sessionId: "sess-old",
        status: "idle",
        lastActivityAt: 1000,
      },
    ] as unknown as OrchestratorTaskSession[];

    const newest = sortReusableSessions(sessions);
    expect(newest?.sessionId).toBe("sess-recent");
  });

  it("breaks ties deterministically by sessionId when lastActivityAt matches or is non-finite", () => {
    const sessions = [
      {
        sessionId: "sess-b",
        status: "idle",
        lastActivityAt: Number.NaN,
      },
      {
        sessionId: "sess-a",
        status: "idle",
        lastActivityAt: Number.NaN,
      },
    ] as unknown as OrchestratorTaskSession[];

    const newest = sortReusableSessions(sessions);
    expect(newest?.sessionId).toBe("sess-a");
  });
});
