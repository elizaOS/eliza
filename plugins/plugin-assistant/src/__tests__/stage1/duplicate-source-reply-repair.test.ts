/**
 * A Stage 1 answer with more than one HANDLE_RESPONSE decision, any of them
 * source-backed (replyText as reply parts), is refused: picking one of two
 * ambiguous decisions is never safe. The refusal was terminal, so a sporadic
 * sample ended the turn (live 2026-11-22, Pixel alpha.v623: "open the phone
 * app" failed with STAGE1_DUPLICATE_SOURCE_REPLY and "Reply failed"; the same
 * message later answered "Opening Phone."). The turn now asks the model once
 * for a single decision, sharing the one turn-wide source-reply repair with
 * STAGE1_INVALID_SOURCE_REPLY, and still fails closed on a second refusal.
 */
import { ChannelType, type State, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

const QUESTION = "What's on my calendar today?";
const EARLIER = "Launch, 12:00-1:00 pm.";
const REPLY = "Launch starts at 12:00 pm.";
const DUPLICATE_CORRECTION =
  "Your previous answer contained more than one HANDLE_RESPONSE decision.";
const INVALID_CORRECTION = "invalid source quote";

/** A dialogue with an earlier assistant reply, so source parts are offered. */
function dialogueState(): State {
  const asked = {
    ...makeMessage({ text: QUESTION }),
    id: "00000000-0000-0000-0000-00000000fd01" as UUID,
    createdAt: 1,
  };
  const answered = {
    ...makeMessage({ text: EARLIER }),
    id: "00000000-0000-0000-0000-00000000fd02" as UUID,
    entityId: "00000000-0000-0000-0000-000000000003" as UUID,
    createdAt: 2,
  };
  return {
    ...makeState(),
    data: {
      providers: {
        RECENT_MESSAGES: { data: { recentMessages: [asked, answered] } },
      },
    },
  } as State;
}

const partsDecision = (replyText: string) =>
  stage1Response({ contexts: ["simple"], replyText, replyParts: true });

/** One model answer carrying two HANDLE_RESPONSE calls. */
function twoDecisions(
  first: ReturnType<typeof stage1Response>,
  second: ReturnType<typeof stage1Response>,
) {
  return {
    ...first,
    toolCalls: [
      first.toolCalls[0],
      { ...second.toolCalls[0], id: "handle-response-2" },
    ],
  };
}

const duplicateSourceDecisions = () =>
  twoDecisions(partsDecision(REPLY), partsDecision("Launch starts at noon."));

function invalidSourceDecision() {
  const response = stage1Response({ contexts: ["simple"] });
  response.toolCalls[0].arguments.replyText = [
    { kind: "source", value: "Launch, 1:00-2:00 pm." },
  ] as never;
  return response;
}

function turn(outputs: unknown[]) {
  const runtime = makeRuntime(outputs);
  const dispatch = vi.spyOn(runtime.responseHandlerFieldRegistry, "dispatch");
  const outcome = runStage1({
    runtime,
    // A conversational message, so a valid decision is answered directly
    // without the planner; the live turn's action request is not the point.
    message: makeMessage({
      text: "what time is launch?",
      channelType: ChannelType.DM,
    }),
    state: dialogueState(),
  });
  const call = (index: number) =>
    JSON.stringify((useModelCalls(runtime)[index] as unknown[])?.[1]);
  return { runtime, dispatch, outcome, call };
}

/** The field registry ran once, on the accepted decision only. */
function expectOnlyDispatched(
  dispatch: ReturnType<typeof turn>["dispatch"],
  replyText: string,
) {
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[0]?.rawParsed?.replyText).toBe(replyText);
}

describe("Stage 1 repair of duplicate source-backed decisions", () => {
  it("asks once for a single decision and answers the turn", async () => {
    const { runtime, dispatch, outcome, call } = turn([
      duplicateSourceDecisions(),
      partsDecision(REPLY),
    ]);
    const result = await outcome;
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe(REPLY);
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(call(0)).not.toContain(DUPLICATE_CORRECTION);
    expect(call(1)).toContain(DUPLICATE_CORRECTION);
    expect(call(1)).not.toContain(INVALID_CORRECTION);
    // Field effects come only from the repaired decision.
    expectOnlyDispatched(dispatch, REPLY);
  });

  it("fails closed when the repaired answer is duplicated again", async () => {
    const { runtime, dispatch, outcome, call } = turn([
      duplicateSourceDecisions(),
      duplicateSourceDecisions(),
      partsDecision(REPLY),
    ]);
    await expect(outcome).rejects.toMatchObject({
      code: "STAGE1_DUPLICATE_SOURCE_REPLY",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(call(1)).toContain(DUPLICATE_CORRECTION);
  });

  it("shares one repair with an invalid source reply (invalid, then duplicate)", async () => {
    const { runtime, dispatch, outcome, call } = turn([
      invalidSourceDecision(),
      duplicateSourceDecisions(),
      partsDecision(REPLY),
    ]);
    await expect(outcome).rejects.toMatchObject({
      code: "STAGE1_DUPLICATE_SOURCE_REPLY",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(call(1)).toContain(INVALID_CORRECTION);
    expect(call(1)).not.toContain(DUPLICATE_CORRECTION);
  });

  it("shares one repair with an invalid source reply (duplicate, then invalid)", async () => {
    const { runtime, dispatch, outcome, call } = turn([
      duplicateSourceDecisions(),
      invalidSourceDecision(),
      partsDecision(REPLY),
    ]);
    await expect(outcome).rejects.toMatchObject({
      code: "STAGE1_INVALID_SOURCE_REPLY",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(call(1)).toContain(DUPLICATE_CORRECTION);
  });

  // Two plain-string decisions are not source-backed, so they are never
  // refused; the existing malformed-HANDLE_RESPONSE retry re-sends the same
  // request (no correction), exactly as before this repair existed.
  it("leaves two plain-string decisions to the existing malformed-call retry", async () => {
    const { runtime, dispatch, outcome, call } = turn([
      twoDecisions(
        stage1Response({ contexts: ["simple"], replyText: "Launch is soon." }),
        stage1Response({ contexts: ["simple"], replyText: "Launch is later." }),
      ),
      stage1Response({ contexts: ["simple"], replyText: REPLY }),
    ]);
    const result = await outcome;
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(call(1)).toBe(call(0));
    expect(call(1)).not.toContain(DUPLICATE_CORRECTION);
    expect(call(1)).not.toContain(INVALID_CORRECTION);
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe(REPLY);
    expectOnlyDispatched(dispatch, REPLY);
  });
});
