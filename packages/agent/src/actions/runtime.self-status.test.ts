/**
 * Verifies the RUNTIME action's `self_status` op resolves the self-awareness
 * registry solely from the AWARENESS_REGISTRY runtime service and fails closed
 * when that service is absent or does not expose `getDetail`. Deterministic:
 * drives the handler against a hand-built in-memory runtime stub, no live model.
 */
import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runtimeAction } from "./runtime.ts";

type AwarenessServiceLike = {
  getDetail: (
    runtime: IAgentRuntime,
    module: string,
    level: "brief" | "full",
  ) => Promise<string>;
};

function makeRuntime(service: AwarenessServiceLike | null): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    actions: [],
    getService: (t: string) => (t === "AWARENESS_REGISTRY" ? service : null),
  } as unknown as IAgentRuntime;
}

const message = { content: { text: "" } } as unknown as Memory;

async function runSelfStatus(runtime: IAgentRuntime): Promise<ActionResult> {
  return (await runtimeAction.handler(
    runtime,
    message,
    {} as State,
    { parameters: { action: "self_status", module: "runtime" } },
    (() => Promise.resolve([])) as unknown as HandlerCallback,
  )) as ActionResult;
}

describe("RUNTIME self_status registry seam", () => {
  it("uses the AWARENESS_REGISTRY service when registered", async () => {
    let seen: { module: string; level: string } | null = null;
    const service: AwarenessServiceLike = {
      getDetail: async (_runtime, module, level) => {
        seen = { module, level };
        return "runtime module detail from service";
      },
    };
    const result = await runSelfStatus(makeRuntime(service));

    expect(result.success).toBe(true);
    expect(result.text).toBe("runtime module detail from service");
    expect(seen).toEqual({ module: "runtime", level: "brief" });
  });

  it("fails closed when no AWARENESS_REGISTRY service is registered", async () => {
    const result = await runSelfStatus(makeRuntime(null));

    expect(result.success).toBe(false);
    expect(result.text).toContain("Self-awareness registry is not available");
  });

  it("fails closed when the service is not a valid registry (no getDetail)", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000aa",
      actions: [],
      getService: (t: string) => (t === "AWARENESS_REGISTRY" ? {} : null),
    } as unknown as IAgentRuntime;
    const result = await runSelfStatus(runtime);

    expect(result.success).toBe(false);
    expect(result.text).toContain("Self-awareness registry is not available");
  });
});
