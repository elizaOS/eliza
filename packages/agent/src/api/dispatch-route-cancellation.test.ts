/**
 * Owner-cancellation coverage for in-process route dispatch. The deterministic
 * handler waits for the same synthetic request-close event used by chat routes.
 */

import { AgentRuntime, type Route, stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { dispatchRoute } from "./dispatch-route";

describe("dispatchRoute owner cancellation", () => {
  it("emits request close and rejects instead of fabricating a 200", async () => {
    const runtime = new AgentRuntime({
      agentId: stringToUuid("dispatch-cancel-agent"),
      character: { name: "cancel-test" },
    });
    let closeObserved = false;
    runtime.routes.push({
      type: "GET",
      path: "/api/cancel",
      name: "cancel test",
      public: true,
      publicReason: "Deterministic in-process cancellation fixture",
      handler: async (req: unknown) => {
        await new Promise<void>((resolve) => {
          (
            req as unknown as {
              once: (event: string, listener: () => void) => void;
            }
          ).once("close", () => {
            closeObserved = true;
            resolve();
          });
        });
      },
    } as unknown as Route);
    const owner = new AbortController();

    const pending = dispatchRoute({
      runtime,
      method: "GET",
      path: "/api/cancel",
      headers: {},
      inProcess: true,
      isAuthorized: () => true,
      abortSignal: owner.signal,
    });
    owner.abort(new DOMException("owner left", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(closeObserved).toBe(true);
  });
});
