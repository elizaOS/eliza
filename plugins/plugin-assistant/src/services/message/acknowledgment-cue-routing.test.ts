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

const allTaughtCues = [
  ...new Set([
    ...quotedCues(ACKNOWLEDGMENT_RULE),
    ...quotedCues(schemaAck ?? ""),
  ]),
];
// Assent is taught only for an action or change, never for a question.
const isAssentCue = (cue: string) => /^(?:sure|yeah)\b/iu.test(cue);
const taughtCues = allTaughtCues.filter((cue) => !isAssentCue(cue));
const taughtAssentCues = allTaughtCues.filter(isAssentCue);
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
    expect(taughtAssentCues).toEqual(
      expect.arrayContaining(["Sure.", "Sure, one sec."]),
    );
  });

  it.each(taughtAssentCues)(
    "speaks a taught assent cue only for an instruction and routes it as an ack: %s",
    (cue) => {
      expect(replyIsClaimSafeAcknowledgment(cue, { assent: true })).toBe(true);
      expect(replyIsClaimSafeAcknowledgment(cue, { assent: false })).toBe(
        false,
      );
      expect(looksLikeProgressOnlyReply(cue)).toBe(true);
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
    "One moment after sunrise is enough.",
    "On it, the alarm is set.",
  ])("keeps an answer that opens with cue words an answer: %s", (reply) => {
    expect(looksLikeProgressOnlyReply(reply)).toBe(false);
    expect(looksLikeCompleteDirectReply(reply)).toBe(true);
  });

  it("allows a captured answer that starts with a duration", () => {
    expect(
      PROGRESS_ONLY_ANSWER_REJECT.test("One moment after sunrise is enough."),
    ).toBe(false);
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
    "One moment. One sec.",
    "Just a second! One sec. One moment.",
  ])("reads a cue before more progress as progress: %s", (reply) => {
    expect(looksLikeProgressOnlyReply(reply)).toBe(true);
    expect(PROGRESS_ONLY_ANSWER_REJECT.test(reply)).toBe(true);
  });

  it.each([
    "Sure.",
    "Sure!",
    "Yeah.",
    "Sure, one sec.",
    "Sure, on it.",
    "Yeah, one sec.",
    "Sure. One sec.",
    "Sure, let me check your calendar.",
    "Sure! Let me open Maps.",
  ])("reads an assent cue as progress: %s", (reply) => {
    expect(looksLikeProgressOnlyReply(reply)).toBe(true);
    expect(looksLikeCompleteDirectReply(reply)).toBe(false);
  });

  // Openers screen non-pending Stage-1 text as a final answer, where a bare
  // "Sure." is a yes, so only assent before more progress opens progress.
  it.each([
    ["Sure, one sec.", true],
    ["Yeah, one sec.", true],
    ["Sure — on it.", true],
    ["Sure, let me check your calendar.", true],
    ["Sure! Let me open Maps.", true],
    ["Sure.", false],
    ["Yeah.", false],
  ] as const)("screens assent as an opener: %s", (reply, progress) => {
    expect(PROGRESS_ONLY_ANSWER_REJECT.test(reply)).toBe(progress);
  });

  it("keeps a declared answer's bare assent an answer", () => {
    expect(looksLikeProgressOnlyReply("Sure.", { bareAssent: false })).toBe(
      false,
    );
    expect(
      looksLikeProgressOnlyReply("Sure, one sec.", { bareAssent: false }),
    ).toBe(true);
    for (const stageOneReplyEffectStatus of ["none", "non_applied"] as const)
      expect(
        shouldSuppressInferredCandidateEscalation({
          inference: { names: ["VIEWS"], kind: "view-capability" },
          stageOneContexts: ["simple"],
          stageOneReplyText: "Sure.",
          stageOneCandidateActions: [],
          stageOneReplyEffectStatus,
          stageOneIntents: [],
        }),
      ).toBe(true);
  });

  it.each([
    "Sure, your dentist is Thursday.",
    "Sure, you're free Friday.",
    "Yeah, it's raining.",
    "Sure, one sec, your dentist is Thursday.",
    "Sure thing, the alarm is set for seven.",
  ])("keeps an answer that opens with assent an answer: %s", (reply) => {
    expect(looksLikeProgressOnlyReply(reply)).toBe(false);
    expect(PROGRESS_ONLY_ANSWER_REJECT.test(reply)).toBe(false);
  });
});
