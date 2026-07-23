/**
 * Pins provider-facing ACP session reads to the real store result: slow reads
 * remain pending and failures propagate instead of becoming a fabricated
 * healthy-empty session list.
 */
import { describe, expect, it } from "vitest";
import {
  type AcpActionService,
  listSessionsWithin,
} from "../actions/common.js";
import type { SessionInfo } from "../services/types.js";

function serviceWith(
  listSessions: () => Promise<SessionInfo[]>,
): AcpActionService {
  return { listSessions } as AcpActionService;
}

describe("provider ACP session reads", () => {
  it("waits for the authoritative store result without an abandoned timeout race", async () => {
    let resolveSessions!: (sessions: SessionInfo[]) => void;
    const sessionsPromise = new Promise<SessionInfo[]>((resolve) => {
      resolveSessions = resolve;
    });
    const read = listSessionsWithin(serviceWith(() => sessionsPromise));
    let settled = false;
    void read.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    const session = { id: "session-1" } as SessionInfo;
    resolveSessions([session]);
    await expect(read).resolves.toEqual([session]);
  });

  it("propagates store failures instead of returning an empty list", async () => {
    const failure = new Error("session store unavailable");
    const read = listSessionsWithin(
      serviceWith(async () => {
        throw failure;
      }),
    );

    await expect(read).rejects.toBe(failure);
  });
});
