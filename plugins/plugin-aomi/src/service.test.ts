/**
 * Verifies room isolation, busy-room protection, and idempotent wallet callback retries.
 */
import { describe, expect, it } from "vitest";
import {
  EVM_REQUEST,
  FakeAomiSession,
  fakeRuntime,
  ROOM_ID,
  SECOND_ROOM_ID,
} from "./__tests__/test-helpers.js";
import { AomiService } from "./service.js";

const CONFIG = {
  apiUrl: "https://api.aomi.dev",
  app: "default",
  chainId: 8453,
};

describe("AomiService", () => {
  it("keeps Aomi sessions isolated by Eliza room", async () => {
    const { runtime } = fakeRuntime();
    const sessions: FakeAomiSession[] = [];
    const service = new AomiService(runtime, CONFIG, {
      createSession: () => {
        const session = new FakeAomiSession(null);
        sessions.push(session);
        return session;
      },
      executeWallet: async () => {
        throw new Error("wallet execution should not run");
      },
    });

    await Promise.all([
      service.submit(String(ROOM_ID), "first room"),
      service.submit(String(SECOND_ROOM_ID), "second room"),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].prompts).toEqual(["first room"]);
    expect(sessions[1].prompts).toEqual(["second room"]);
  });

  it("rejects a second operation while the room has a pending wallet request", async () => {
    const { runtime } = fakeRuntime();
    const service = new AomiService(runtime, CONFIG, {
      createSession: () => new FakeAomiSession(EVM_REQUEST),
      executeWallet: async () => ({
        kind: "transaction",
        txHash: "0x123",
      }),
    });

    const first = await service.submit(String(ROOM_ID), "prepare transfer");
    expect(first.status).toBe("wallet_required");
    await expect(
      service.submit(String(ROOM_ID), "replace transfer"),
    ).rejects.toMatchObject({ code: "AOMI_ROOM_BUSY" });
  });

  it("does not execute a wallet request twice when the Aomi callback is retried", async () => {
    const { runtime } = fakeRuntime();
    const session = new FakeAomiSession(EVM_REQUEST);
    session.failResolveCount = 1;
    let executions = 0;
    const service = new AomiService(runtime, CONFIG, {
      createSession: () => session,
      executeWallet: async () => {
        executions += 1;
        return {
          kind: "transaction",
          txHash: "0xabc",
        };
      },
    });

    await service.submit(String(ROOM_ID), "prepare transfer");
    await expect(service.confirm(String(ROOM_ID))).rejects.toThrow(
      "callback failed",
    );
    expect(service.pending(String(ROOM_ID))?.executionReady).toBe(true);

    const completed = await service.confirm(String(ROOM_ID));
    expect(completed.status).toBe("completed");
    expect(executions).toBe(1);
    expect(session.resolved).toHaveLength(2);
  });

  it("clears failed completion state instead of leaving the room permanently busy", async () => {
    const { runtime } = fakeRuntime();
    const session = new FakeAomiSession(null, undefined, false);
    const service = new AomiService(runtime, CONFIG, {
      createSession: () => session,
      executeWallet: async () => {
        throw new Error("wallet execution should not run");
      },
    });

    const failed = service.submit(String(ROOM_ID), "read-only request");
    session.failCompletion(new Error("backend unavailable"));
    await expect(failed).rejects.toMatchObject({ code: "AOMI_REQUEST_FAILED" });
    expect(service.pending(String(ROOM_ID))).toBeNull();

    await expect(
      service.submit(String(ROOM_ID), "retry request"),
    ).rejects.toMatchObject({ code: "AOMI_REQUEST_FAILED" });
  });
});
