import {
  getTrajectoryContext,
  type IAgentRuntime,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubAgentRouter } from "../services/sub-agent-router.js";

describe("SubAgentRouter session-event trajectory boundary", () => {
  let stopRouter: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stopRouter?.();
    stopRouter = undefined;
  });

  it("does not inherit a terminal parent turn into an ACP event", async () => {
    let listener:
      | ((sessionId: string, event: "message", data: unknown) => void)
      | undefined;
    const acp = {
      onSessionEvent: (
        next: (sessionId: string, event: "message", data: unknown) => void,
      ) => {
        listener = next;
        return () => {};
      },
    };
    const runtime = {
      getSetting: () => undefined,
      getService: (serviceType: string) =>
        serviceType === "ACP_SUBPROCESS_SERVICE" ? acp : null,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as IAgentRuntime;
    const router = new SubAgentRouter(runtime);
    const observed: Array<ReturnType<typeof getTrajectoryContext>> = [];
    (
      router as unknown as {
        handleEvent: () => Promise<void>;
      }
    ).handleEvent = async () => {
      observed.push(getTrajectoryContext());
    };
    await router.start();
    stopRouter = () => router.stop();
    expect(listener).toBeTypeOf("function");

    await runWithTrajectoryContext(
      { trajectoryStepId: "closed-parent-step" },
      async () => listener?.("session-1", "message", {}),
    );

    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0]).toBeUndefined();
  });
});
