/**
 * Regression tests for reminder owner-response classification (#14717): the
 * semantic (LLM) classifier is the primary judge; the only deterministic path
 * is the exact-match fast-path for replies that ARE a bare resolution word or
 * duration. Deterministic harness — the semantic seam is stubbed at its
 * injection boundary, and the model boundary test stubs runtime.useModel to
 * capture the real prompt.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type RemindersDeps,
  RemindersDomain,
} from "../src/lifeops/domains/reminders-service.js";
import type { LifeOpsContext } from "../src/lifeops/lifeops-context.js";
import {
  classifyExactReminderReply,
  classifyReminderOwnerResponse,
  type ReminderOwnerResponseClassificationInput,
  type ReminderOwnerResponseContext,
  type ReminderOwnerResponseSemanticClassification,
} from "../src/lifeops/service-helpers-reminder.js";

const ATTEMPTED_AT = "2026-07-05T10:00:00.000Z";

function adjacentContext(
  overrides: Partial<ReminderOwnerResponseContext> = {},
): ReminderOwnerResponseContext {
  return {
    title: "dentist appointment",
    attemptedAt: ATTEMPTED_AT,
    respondedAt: "2026-07-05T10:02:00.000Z",
    channel: "in_app",
    allowStandaloneResolution: true,
    ...overrides,
  };
}

function stubSemantic(
  result: ReminderOwnerResponseSemanticClassification | null,
): {
  classifier: (
    input: ReminderOwnerResponseClassificationInput,
  ) => Promise<ReminderOwnerResponseSemanticClassification | null>;
  calls: ReminderOwnerResponseClassificationInput[];
} {
  const calls: ReminderOwnerResponseClassificationInput[] = [];
  return {
    calls,
    classifier: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

describe("classifyReminderOwnerResponse (#14717)", () => {
  it("routes negated keyword sentences to the semantic classifier instead of regex-resolving them", async () => {
    // Pre-#14717 the \bskip\b table classified this as an explicit skip.
    const semantic = stubSemantic({
      decision: "unrelated",
      resolution: null,
      snoozeRequest: null,
      confidence: 0.9,
      reason: "owner_declines_skip",
    });
    const result = await classifyReminderOwnerResponse({
      text: "no, don't skip it",
      context: adjacentContext(),
      semanticClassifier: semantic.classifier,
    });

    expect(semantic.calls).toHaveLength(1);
    expect(semantic.calls[0].text).toBe("no, don't skip it");
    expect(semantic.calls[0].context?.title).toBe("dentist appointment");
    expect(result.decision).toBe("unrelated");
    expect(result.resolution).toBeNull();
    expect(result.classifierSource).toBe("semantic");
  });

  it("routes keyword-bearing sentences to the semantic classifier and its verdict wins", async () => {
    // Pre-#14717 \bdone\b + title-token overlap resolved this as completed.
    const semantic = stubSemantic({
      decision: "needs_clarification",
      resolution: null,
      snoozeRequest: null,
      confidence: 0.7,
      reason: "owner_says_not_done_yet",
    });
    const result = await classifyReminderOwnerResponse({
      text: "the dentist appointment isn't done yet, ping me tomorrow",
      context: adjacentContext(),
      semanticClassifier: semantic.classifier,
    });

    expect(semantic.calls).toHaveLength(1);
    expect(result.decision).toBe("needs_clarification");
    expect(result.classifierSource).toBe("semantic");
    expect(result.semanticReason).toBe("owner_says_not_done_yet");
  });

  it("resolves bare exact replies deterministically without a model (keyless lanes)", async () => {
    const done = await classifyReminderOwnerResponse({
      text: "Done!",
      context: adjacentContext(),
    });
    expect(done).toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
      classifierSource: "deterministic",
      confidence: 1,
    });

    const duration = await classifyReminderOwnerResponse({
      text: "30m",
      context: adjacentContext(),
    });
    expect(duration).toMatchObject({
      decision: "explicit_resolution",
      resolution: "snoozed",
      snoozeRequest: { preset: "30m" },
    });

    const oddDuration = await classifyReminderOwnerResponse({
      text: "2 hours",
      context: adjacentContext(),
    });
    expect(oddDuration.snoozeRequest).toEqual({ minutes: 120 });

    const vagueSnooze = await classifyReminderOwnerResponse({
      text: "not now",
      context: adjacentContext(),
    });
    expect(vagueSnooze).toMatchObject({
      decision: "needs_clarification",
      reason: "snooze_needs_duration",
    });
  });

  it("does not fast-path exact replies when standalone resolution is disallowed", async () => {
    const semantic = stubSemantic({
      decision: "abstain",
      resolution: null,
      snoozeRequest: null,
      confidence: 0.4,
      reason: "competing_prompts",
    });
    const result = await classifyReminderOwnerResponse({
      text: "done",
      context: adjacentContext({ allowStandaloneResolution: false }),
      semanticClassifier: semantic.classifier,
    });
    expect(semantic.calls).toHaveLength(1);
    expect(result.decision).toBe("unrelated");
    expect(result.classifierSource).toBe("semantic_abstain");
  });

  it("does not fast-path exact replies outside the prompt-adjacency window", () => {
    const result = classifyExactReminderReply(
      "done",
      adjacentContext({ respondedAt: "2026-07-05T10:30:00.000Z" }),
    );
    expect(result).toBeNull();
  });

  it("reports an honest non-verdict when no semantic classifier is available", async () => {
    const result = await classifyReminderOwnerResponse({
      text: "I finished the dentist thing yesterday",
      context: adjacentContext(),
    });
    expect(result).toMatchObject({
      decision: "unrelated",
      resolution: null,
      confidence: 0,
      reason: "no_semantic_verdict",
      classifierSource: "none",
    });
  });

  it("propagates a throwing semantic classifier instead of swallowing it", async () => {
    await expect(
      classifyReminderOwnerResponse({
        text: "handled it while you were away",
        context: adjacentContext(),
        semanticClassifier: async () => {
          throw new Error("classifier exploded");
        },
      }),
    ).rejects.toThrow("classifier exploded");
  });
});

describe("classifyReminderOwnerResponseSemantically model boundary (#14717)", () => {
  function domainWithModel(response: string): {
    domain: RemindersDomain;
    prompts: string[];
  } {
    const prompts: string[] = [];
    const useModel = async (
      _modelType: string,
      params: { prompt: string },
    ): Promise<string> => {
      prompts.push(params.prompt);
      return response;
    };
    const ctx = {
      runtime: { useModel } as unknown as IAgentRuntime,
    } as LifeOpsContext;
    return {
      domain: new RemindersDomain(ctx, {} as RemindersDeps),
      prompts,
    };
  }

  it("sends the owner reply and reminder context to the model and parses its structured verdict", async () => {
    const { domain, prompts } = domainWithModel(
      JSON.stringify({
        decision: "explicit_resolution",
        resolution: "snoozed",
        snoozeMinutes: 45,
        snoozePreset: null,
        confidence: 0.9,
        reason: "wants_45_minutes",
      }),
    );

    const result = await domain.classifyReminderOwnerResponseSemantically({
      text: "no, don't skip it — give me 45 minutes",
      context: {
        title: "dentist appointment",
        attemptedAt: ATTEMPTED_AT,
        respondedAt: "2026-07-05T10:02:00.000Z",
        channel: "in_app",
        allowStandaloneResolution: false,
      },
    });

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain("no, don't skip it — give me 45 minutes");
    expect(prompt).toContain("dentist appointment");
    expect(prompt).toContain("allowStandaloneResolution: false");
    expect(result).toMatchObject({
      decision: "explicit_resolution",
      resolution: "snoozed",
      snoozeRequest: { minutes: 45 },
      confidence: 0.9,
    });
  });

  it("returns null (not a fabricated verdict) when the model output is unparseable", async () => {
    const { domain } = domainWithModel("sure thing, marking it complete!");
    const result = await domain.classifyReminderOwnerResponseSemantically({
      text: "no, don't skip it",
      context: { title: "dentist appointment" },
    });
    expect(result).toBeNull();
  });
});
