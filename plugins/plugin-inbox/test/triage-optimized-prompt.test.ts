/**
 * Routing coverage for the `inbox_triage` LifeOps optimization task (#8795).
 *
 * The triage classification instructions must consult OptimizedPromptService and
 * use an optimized artifact when one is registered, falling back to the inline
 * baseline otherwise (absence of an artifact is a no-op, never a failure) — the
 * same contract `morning_brief`/`calendar_extract` already follow.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildTriagePrompt,
  INBOX_TRIAGE_INSTRUCTIONS,
} from "../src/inbox/triage-classifier.js";
import type { InboundMessage } from "../src/inbox/types.js";

const MESSAGES: InboundMessage[] = [
  {
    id: "msg-1",
    source: "gmail",
    senderName: "Sam Rivera",
    channelName: "Primary",
    channelType: "dm",
    text: "Can you confirm the 3pm sync still works for you?",
  },
];

function runtimeWithOptimizedPrompt(
  promptByTask: Record<string, string>,
): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              promptByTask[task]
                ? { prompt: promptByTask[task], optimizerSource: "gepa" }
                : null,
          }
        : null,
  } as unknown as IAgentRuntime;
}

describe("inbox triage — OptimizedPromptService routing", () => {
  it("uses the inline baseline when no runtime is provided", () => {
    const prompt = buildTriagePrompt(MESSAGES, {});
    expect(prompt).toContain(INBOX_TRIAGE_INSTRUCTIONS);
    expect(prompt).toContain("Sam Rivera");
  });

  it("carries the uncertain-keep affordance so ambiguous messages are never filed as ignore (#14631)", () => {
    // The over-dismissal failure mode: a terse, unsigned note from an
    // unrecognized address confidently labeled junk. The baseline must give
    // the model an explicit uncertainty outcome — keep it visible, lower
    // confidence — instead of leaving "ignore" as the only junk-shaped bucket.
    expect(INBOX_TRIAGE_INSTRUCTIONS).toContain("do NOT classify it as ignore");
    expect(INBOX_TRIAGE_INSTRUCTIONS).toContain(
      "least-dismissive plausible category",
    );
    expect(INBOX_TRIAGE_INSTRUCTIONS).toContain("state the uncertainty");
  });

  it("uses the inline baseline when the runtime has no optimized prompt", () => {
    const prompt = buildTriagePrompt(MESSAGES, {
      runtime: runtimeWithOptimizedPrompt({}),
    });
    expect(prompt).toContain(
      "Classify each message into one of these categories:",
    );
  });

  it("swaps in the optimized inbox_triage artifact and preserves message data", () => {
    const prompt = buildTriagePrompt(MESSAGES, {
      runtime: runtimeWithOptimizedPrompt({
        inbox_triage: "OPTIMIZED: prefer needs_reply when a question is asked.",
      }),
    });
    expect(prompt).toContain(
      "OPTIMIZED: prefer needs_reply when a question is asked.",
    );
    // The inline baseline instructions are replaced by the artifact.
    expect(prompt).not.toContain(
      "Classify each message into one of these categories:",
    );
    // The dynamic message scaffold is preserved around the instructions.
    expect(prompt).toContain("Messages to classify:");
    expect(prompt).toContain("Sam Rivera");
  });
});
