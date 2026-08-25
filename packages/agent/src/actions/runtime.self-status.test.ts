/**
 * Verifies the RUNTIME action's `self_status` op resolves the self-awareness
 * registry solely from the AWARENESS_REGISTRY runtime service, bounds returned
 * detail, and degrades to live status when the registry is unavailable.
 * Deterministic: drives the handler against an in-memory runtime stub.
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
    providers: [],
    character: { name: "test-agent", settings: {} },
    getServicesByType: () => [],
    getService: (t: string) => (t === "AWARENESS_REGISTRY" ? service : null),
  } as unknown as IAgentRuntime;
}

const message = { content: { text: "" } } as unknown as Memory;

async function runSelfStatus(
  runtime: IAgentRuntime,
  detailLevel: "brief" | "full" = "brief",
): Promise<ActionResult> {
  return (await runtimeAction.handler(
    runtime,
    message,
    {} as State,
    {
      parameters: {
        action: "self_status",
        module: "runtime",
        detailLevel,
      },
    },
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

  it.each(["brief", "full"] as const)(
    "retains complete %s detail",
    async (detailLevel) => {
      const detail = `start-${"x".repeat(20_000)}-end`;
      const service: AwarenessServiceLike = {
        getDetail: async () => detail,
      };

      const result = await runSelfStatus(makeRuntime(service), detailLevel);

      expect(result.success).toBe(true);
      expect(result.text).toBe(detail);
      expect(result.data?.truncated).toBe(false);
    },
  );

  it("degrades to the live status snapshot when no AWARENESS_REGISTRY service is registered", async () => {
    // The registry is optional enrichment; without it the runtime still owns a
    // real answer (live incident: a self-description question got the generic
    // failed-tool apology because this path hard-failed).
    const result = await runSelfStatus(makeRuntime(null));

    expect(result.success).toBe(true);
    expect(result.text).toContain("Self-awareness registry is not loaded");
    expect(result.text?.length ?? 0).toBeGreaterThan(60);
  });

  it("degrades to the snapshot when the service is not a valid registry (no getDetail)", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000aa",
      actions: [],
      providers: [],
      character: { name: "test-agent", settings: {} },
      getServicesByType: () => [],
      getService: (t: string) => (t === "AWARENESS_REGISTRY" ? {} : null),
    } as unknown as IAgentRuntime;
    const result = await runSelfStatus(runtime);

    expect(result.success).toBe(true);
    expect(result.text).toContain("Self-awareness registry is not loaded");
  });
});
