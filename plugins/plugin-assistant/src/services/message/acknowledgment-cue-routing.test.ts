import { HANDLE_RESPONSE_SCHEMA } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { ACKNOWLEDGMENT_RULE } from "../../prompts/acknowledgment.ts";
import { PROGRESS_ONLY_ANSWER_REJECT } from "../../runtime/planner-loop.ts";
import { replyIsClaimSafeAcknowledgment } from "./side-effect-claims.ts";
import {
  looksLikeCompleteDirectReply,
  looksLikeProgressOnlyReply,
  shouldSuppressInferredCandidateEscalation,
} from "./stage1-reply-policy.ts";

// Every cue the model is taught to write must also read as an ack to the
// routing classifiers, or a turn that carries it routes differently from one
// that carries "On it." (a mislabelled cue ships as the final reply, or a view
// candidate is never seeded).
function quotedCues(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((quote) => !quote.endsWith("..."));
}

const handleResponseReplyText = (
  HANDLE_RESPONSE_SCHEMA.properties as Record<string, { description?: string }>
).replyText?.description;
const schemaAck = /Planning=brief ack \(([^)]*)\)/u.exec(
  handleResponseReplyText ?? "",
)?.[1];

const taughtCues = [
  ...new Set([
    ...quotedCues(ACKNOWLEDGMENT_RULE),
    ...quotedCues(schemaAck ?? ""),
  ]),
];
const waitCueVariants = [
  "On it!",
  "on it",
  "One sec!",
  "One second.",
  "Just a sec.",
  "Just a second.",
  "One moment.",
  "Just a moment.",
  "just a moment",
];

describe("acknowledgment cues and the routing classifiers", () => {
  it("reads the cues from the rule and the HANDLE_RESPONSE schema", () => {
    expect(schemaAck).toBeDefined();
    expect(taughtCues).toEqual(
      expect.arrayContaining(["On it.", "One sec.", "Let me check."]),
    );
  });

  it.each([...taughtCues, ...waitCueVariants])(
    "treats the taught cue as an ack everywhere: %s",
    (cue) => {
      expect(replyIsClaimSafeAcknowledgment(cue)).toBe(true);
      expect(looksLikeProgressOnlyReply(cue)).toBe(true);
      expect(PROGRESS_ONLY_ANSWER_REJECT.test(cue)).toBe(true);
      expect(looksLikeCompleteDirectReply(cue)).toBe(false);
      expect(
        shouldSuppressInferredCandidateEscalation({
          inference: { names: ["VIEWS"], kind: "view-capability" },
          stageOneContexts: ["simple"],
          stageOneReplyText: cue,
          stageOneCandidateActions: [],
          stageOneReplyEffectStatus: "pending",
          stageOneIntents: [],
        }),
      ).toBe(false);
    },
  );

  it("still lets an answer-shaped reply suppress the inferred candidate", () => {
    expect(
      shouldSuppressInferredCandidateEscalation({
        inference: { names: ["VIEWS"], kind: "view-capability" },
        stageOneContexts: ["simple"],
        stageOneReplyText: "The airport is about twenty minutes away.",
        stageOneCandidateActions: [],
        stageOneReplyEffectStatus: "pending",
        stageOneIntents: [],
      }),
    ).toBe(true);
  });

  // A wait cue opens progress only as the whole reply or before more
  // progress, so answers that open with the same words stay answers.
  it.each([
    "One second is 1,000 milliseconds.",
    "One second-hand option is the Pixel eight.",
    "Just a second ago the build finished green.",
    "On it — the alarm is set for seven tomorrow.",
    "Just a second, your dentist is Thursday, not Tuesday.",
    "One second, then it retries automatically.",
    "One second... then release.",
    "Just a moment ago the build finished green.",
    "On it, the alarm is set.",
  ])("keeps an answer that opens with cue words an answer: %s", (reply) => {
    expect(looksLikeProgressOnlyReply(reply)).toBe(false);
    expect(looksLikeCompleteDirectReply(reply)).toBe(true);
  });

  it.each([
    "One sec, let me check.",
    "Just a second, pulling it up.",
    "One sec — let me check your calendar.",
    "One sec: let me check your calendar.",
    "One sec; let me check.",
    "One sec - let me check your calendar.",
    "On it, let me check your calendar.",
    "On it. Let me check your calendar.",
    "Just a moment, let me check your calendar.",
  ])("reads a cue before more progress as progress: %s", (reply) => {
    expect(looksLikeProgressOnlyReply(reply)).toBe(true);
    expect(PROGRESS_ONLY_ANSWER_REJECT.test(reply)).toBe(true);
  });
});
