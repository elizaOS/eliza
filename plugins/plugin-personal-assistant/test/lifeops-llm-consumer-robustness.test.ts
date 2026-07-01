/**
 * Robustness matrix for the LifeOps LLM consumers (#8795).
 *
 * The optimized-prompt routing tests (lifeops-optimized-prompts.test.ts,
 * brief-optimized-prompt.test.ts) are happy-path only: their `useModel` mock
 * always returns a well-formed string. This suite covers the *failure* axis —
 * malformed JSON, empty / non-string output, and a thrown `useModel` — and
 * asserts each surviving consumer degrades to its documented safe default
 * instead of leaking an unhandled rejection or fabricating data.
 *
 * Consumers under test (extract-gmail-plan was removed on develop, #9576):
 *   - resolveSchedulingPlanWithLlm (src/actions/lib/scheduling-handler.ts)
 *   - renderReminderBody         (src/lifeops/service-mixin-reminders.ts)
 *   - composeNarrative           (src/actions/brief.ts, via the BRIEF handler)
 */
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";

const ReminderService = LifeOpsService;

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/agent")>("@elizaos/agent");
  return { ...actual, hasOwnerAccess: mocks.hasOwnerAccess };
});

function userMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000201" as UUID,
    entityId: "00000000-0000-0000-0000-000000000202" as UUID,
    roomId: "00000000-0000-0000-0000-000000000203" as UUID,
    content: { text },
  } as unknown as Memory;
}

/**
 * Runtime whose `useModel` is supplied by the test. Mirrors the shape used by
 * the happy-path harness (`lifeops-optimized-prompts.test.ts`) but lets each
 * case decide what the model returns or whether it throws.
 */
function runtimeWithModel(
  useModel: (
    modelType: unknown,
    params: { prompt?: string },
  ) => Promise<unknown>,
): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000204" as UUID,
    character: { name: "Eliza", settings: {} },
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    getService: () => null,
    getMemories: vi.fn(async () => []),
    useModel: vi.fn(useModel),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
});

describe("resolveSchedulingPlanWithLlm — malformed / empty / throwing model", () => {
  async function runScheduling(
    useModel: (
      modelType: unknown,
      params: { prompt?: string },
    ) => Promise<unknown>,
  ) {
    const { runSchedulingNegotiationHandler } = await import(
      "../src/actions/lib/scheduling-handler.js"
    );
    const runtime = runtimeWithModel(useModel);
    // No explicit subaction in params, so routing depends entirely on the
    // (failing) planner — exactly the path the safe default protects.
    return runSchedulingNegotiationHandler(
      runtime,
      userMessage("Start a scheduling thread with Mia for next week"),
      undefined,
      { parameters: {} } as unknown as HandlerOptions,
    );
  }

  // The safe default is structural: the planner yields no subaction / no
  // shouldAct, so the handler returns a clarify ActionResult
  // (success=false, requiresConfirmation) instead of starting a negotiation
  // on garbage. The user-facing reply text is rendered downstream by the
  // grounded-reply layer and is not part of this consumer's contract.
  it("(a) invalid JSON → safe clarify default, no negotiation started", async () => {
    const result = await runScheduling(async () => "this is not json at all");
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MISSING_SUBACTION",
      requiresConfirmation: true,
    });
  });

  it("(b) empty string → safe clarify default", async () => {
    const result = await runScheduling(async () => "");
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MISSING_SUBACTION",
      requiresConfirmation: true,
    });
  });

  it("(c) useModel throws → no unhandled rejection, safe clarify default", async () => {
    const result = await runScheduling(async () => {
      throw new Error("model exploded");
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "MISSING_SUBACTION",
      requiresConfirmation: true,
    });
  });
});

describe("renderReminderBody — malformed / empty / throwing model", () => {
  const reminderArgs = {
    title: "Take medication",
    scheduledFor: "2026-06-23T15:00:00.000Z",
    dueAt: "2026-06-23T15:00:00.000Z",
    channel: "push" as const,
    lifecycle: "initial" as const,
    urgency: "normal" as const,
    subjectType: "owner" as const,
    nearbyReminderTitles: ["Drink water"],
  };

  // Deterministic fallback produced by buildReminderBody for these args.
  const deterministicFallback = "Reminder: Take medication";

  it("useModel throws → deterministic fallback body", async () => {
    const service = new ReminderService(
      runtimeWithModel(async () => {
        throw new Error("model exploded");
      }),
    );
    const text = await service.renderReminderBody(reminderArgs);
    expect(text).toContain(deterministicFallback);
  });

  it("non-string (malformed) model output → deterministic fallback body", async () => {
    const service = new ReminderService(
      runtimeWithModel(async () => ({ unexpected: "object" })),
    );
    const text = await service.renderReminderBody(reminderArgs);
    expect(text).toContain(deterministicFallback);
  });

  it("empty / whitespace model output → deterministic fallback body", async () => {
    const service = new ReminderService(runtimeWithModel(async () => "   "));
    const text = await service.renderReminderBody(reminderArgs);
    expect(text).toContain(deterministicFallback);
  });
});

describe("composeNarrative (BRIEF) — throwing / malformed model", () => {
  async function runBrief(
    useModel: (
      modelType: unknown,
      params: { prompt?: string },
    ) => Promise<unknown>,
  ) {
    const { briefAction } = await import("../src/actions/brief.js");
    const runtime = runtimeWithModel(useModel);
    return briefAction.handler(
      runtime,
      userMessage("give me my morning brief"),
      undefined,
      {
        parameters: { subaction: "compose_morning" },
      } as unknown as HandlerOptions,
      async () => undefined,
    );
  }

  it("useModel throws → structured briefing without a narrative (no unhandled rejection)", async () => {
    const result = await runBrief(async () => {
      throw new Error("model exploded");
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      briefing: { kind: string; narrative?: string; sections: unknown };
    };
    expect(data.briefing.kind).toBe("morning");
    expect(data.briefing.narrative).toBeUndefined();
    expect(data.briefing.sections).toBeDefined();
    // Action still returns a usable text even with no LLM narrative.
    expect(typeof result.text).toBe("string");
    expect(result.text?.length ?? 0).toBeGreaterThan(0);
  });

  it("non-string (malformed) model output → structured briefing without a narrative", async () => {
    const result = await runBrief(async () => ({ unexpected: "object" }));
    expect(result.success).toBe(true);
    const data = result.data as { briefing: { narrative?: string } };
    expect(data.briefing.narrative).toBeUndefined();
  });
});
