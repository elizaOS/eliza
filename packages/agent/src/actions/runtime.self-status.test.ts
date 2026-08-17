/**
 * Verifies the RUNTIME action's `self_status` op resolves the self-awareness
 * registry solely from the AWARENESS_REGISTRY runtime service, fails closed when
 * that service is absent or does not expose `getDetail`, and keeps truncated
 * brief/full detail within the configured character caps once the truncation
 * suffix is reserved (issue #20762). Deterministic: drives the handler against a
 * hand-built in-memory runtime stub, no live model.
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

async function runSelfStatus(runtime: IAgentRuntime): Promise<ActionResult> {
  return (await runtimeAction.handler(
    runtime,
    message,
    {} as State,
    { parameters: { action: "self_status", module: "runtime" } },
    (() => Promise.resolve([])) as unknown as HandlerCallback,
  )) as ActionResult;
}

async function runSelfStatusDetail(
  runtime: IAgentRuntime,
  detailLevel: "brief" | "full",
): Promise<ActionResult> {
  return (await runtimeAction.handler(
    runtime,
    message,
    {} as State,
    { parameters: { action: "self_status", module: "runtime", detailLevel } },
    (() => Promise.resolve([])) as unknown as HandlerCallback,
  )) as ActionResult;
}

const SELF_STATUS_TRUNCATION_SUFFIX = "\n…[self-status truncated]";
const MAX_SELF_STATUS_BRIEF_CHARS = 1200;
const MAX_SELF_STATUS_FULL_CHARS = 8000;

function makeOversizedRuntime(payload: string): IAgentRuntime {
  return makeRuntime({ getDetail: async () => payload });
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

  it("degrades to the live status snapshot when no AWARENESS_REGISTRY service is registered", async () => {
    // The registry is optional enrichment; without it the runtime still owns a
    // real answer (live incident: a self-description question got the generic
    // failed-tool apology because this path hard-failed).
    const result = await runSelfStatus(makeRuntime(null));

    expect(result.success).toBe(true);
    expect(result.text).toContain("Self-awareness registry is not loaded");
    expect(result.text?.length ?? 0).toBeGreaterThan(60);
  });

  it("caps a brief self-status result at MAX_SELF_STATUS_BRIEF_CHARS including the suffix", async () => {
    const result = await runSelfStatusDetail(
      makeOversizedRuntime("x".repeat(5000)),
      "brief",
    );

    expect(result.success).toBe(true);
    expect(result.text?.length ?? 0).toBeLessThanOrEqual(
      MAX_SELF_STATUS_BRIEF_CHARS,
    );
    expect(result.text?.endsWith(SELF_STATUS_TRUNCATION_SUFFIX)).toBe(true);
    expect(result.data?.truncated).toBe(true);
  });

  it("caps a full self-status result at MAX_SELF_STATUS_FULL_CHARS including the suffix", async () => {
    const result = await runSelfStatusDetail(
      makeOversizedRuntime("x".repeat(20000)),
      "full",
    );

    expect(result.success).toBe(true);
    expect(result.text?.length ?? 0).toBeLessThanOrEqual(
      MAX_SELF_STATUS_FULL_CHARS,
    );
    expect(result.text?.includes(SELF_STATUS_TRUNCATION_SUFFIX)).toBe(true);
    expect(result.data?.truncated).toBe(true);
  });

  it("returns under-cap detail verbatim without the truncation suffix", async () => {
    const body = "a compact self-status answer";
    const result = await runSelfStatusDetail(
      makeOversizedRuntime(body),
      "brief",
    );

    expect(result.text).toBe(body);
    expect(result.text?.includes(SELF_STATUS_TRUNCATION_SUFFIX)).toBe(false);
    expect(result.data?.truncated).toBe(false);
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
