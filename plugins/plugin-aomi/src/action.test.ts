/**
 * Proves the action cannot execute a wallet request until a separate user confirmation turn.
 */
import type { ActionResult, HandlerOptions } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  EVM_REQUEST,
  FakeAomiSession,
  fakeRuntime,
  memory,
  ROOM_ID,
} from "./__tests__/test-helpers.js";
import { aomiAction } from "./action.js";
import { AomiService } from "./service.js";

describe("AOMI action confirmation", () => {
  it("previews on the initiating turn and executes only after a later yes", async () => {
    const { runtime, services } = fakeRuntime();
    const session = new FakeAomiSession(EVM_REQUEST);
    let executions = 0;
    const service = new AomiService(
      runtime,
      {
        apiUrl: "https://api.aomi.dev",
        app: "default",
        chainId: 8453,
      },
      {
        createSession: () => session,
        executeWallet: async () => {
          executions += 1;
          return { kind: "transaction", txHash: "0xfeed" };
        },
      },
    );
    services.set(AomiService.serviceType, service);

    const first = (await aomiAction.handler(
      runtime,
      memory("Ask Aomi to transfer funds."),
      undefined,
      {
        parameters: { prompt: "Transfer the requested funds on Base." },
      } as HandlerOptions,
    )) as ActionResult;

    expect(first.success).toBe(true);
    expect(first.data?.status).toBe("awaiting_confirmation");
    expect(executions).toBe(0);
    expect(session.resolved).toHaveLength(0);

    const second = (await aomiAction.handler(
      runtime,
      memory("yes"),
    )) as ActionResult;

    expect(second.success).toBe(true);
    expect(second.data?.status).toBe("completed");
    expect(executions).toBe(1);
    expect(session.resolved).toHaveLength(1);
    expect(service.pending(String(ROOM_ID))).toBeNull();
  });

  it("rejects the exact pending request on a non-confirming reply", async () => {
    const { runtime, services } = fakeRuntime();
    const session = new FakeAomiSession(EVM_REQUEST);
    const service = new AomiService(
      runtime,
      {
        apiUrl: "https://api.aomi.dev",
        app: "default",
        chainId: 8453,
      },
      {
        createSession: () => session,
        executeWallet: async () => {
          throw new Error("wallet execution should not run");
        },
      },
    );
    services.set(AomiService.serviceType, service);

    await aomiAction.handler(runtime, memory("Prepare a transfer."));
    const rejected = (await aomiAction.handler(
      runtime,
      memory("no"),
    )) as ActionResult;

    expect(rejected.data?.status).toBe("rejected");
    expect(session.rejected).toEqual([
      {
        id: EVM_REQUEST.id,
        reason: "User rejected the wallet request.",
      },
    ]);
    expect(session.resolved).toHaveLength(0);
  });
});
