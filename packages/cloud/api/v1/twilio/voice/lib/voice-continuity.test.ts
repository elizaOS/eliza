/** Verifies deterministic, privacy-safe phone conversation lifecycle prompts. */

import { describe, expect, test } from "bun:test";
import {
  callEndedEvent,
  callOpeningClientMessageId,
  callOpeningPrompt,
  callStartedEvent,
  claimInboundCallOpeningContext,
  type InboundCallOpeningClaim,
  prewarmAndRecordVoiceCallStart,
  relativeInteractionAge,
  resolveCallContinuityContext,
} from "./voice-continuity";

describe("voice continuity", () => {
  const now = Date.UTC(2026, 7, 15, 12);

  test("describes first contact without inventing history", () => {
    expect(callStartedEvent(false, now - 3 * 60 * 60_000, now)).toContain(
      "first recorded interaction",
    );
  });

  test("bounds prior interaction age into spoken units", () => {
    expect(relativeInteractionAge(now - 3 * 60 * 60_000, now)).toBe("3 hours");
    expect(callStartedEvent(true, now - 2 * 86_400_000, now)).toContain(
      "about 2 days ago",
    );
  });

  test("promotes rounded interaction ages into natural units", () => {
    expect(relativeInteractionAge(now - 59.6 * 60_000, now)).toBe("1 hour");
    expect(relativeInteractionAge(now - 23.6 * 60 * 60_000, now)).toBe("1 day");
  });

  test("generates a first-contact prompt without implied familiarity", () => {
    const prompt = callOpeningPrompt(false, undefined, now);

    expect(prompt).toContain("first recorded interaction");
    expect(prompt).toContain("without pretending familiarity");
    expect(prompt).not.toContain("prior private conversation history");
    expect(prompt).not.toContain("last recorded interaction was about");
  });

  test("generates a returning prompt from elapsed time and private history", () => {
    const prompt = callOpeningPrompt(true, now - 3 * 60 * 60_000, now);

    expect(prompt).toContain("last recorded interaction was about 3 hours ago");
    expect(prompt).toContain("private conversation history");
    expect(prompt).toContain("exactly one brief, natural spoken greeting");
    expect(prompt).toContain("untrusted conversational data");
    expect(prompt).toContain("Do not quote or recite raw history");
  });

  test("keeps returning status when elapsed time is unavailable", () => {
    for (const previousInteractionAt of [undefined, now + 1]) {
      const prompt = callOpeningPrompt(true, previousInteractionAt, now);
      expect(prompt).toContain("prior private conversation history");
      expect(prompt).toContain("no reliable elapsed-time value");
      expect(prompt).not.toContain("first recorded interaction");
    }
  });

  test("uses a distinct stable identity for the generated opening turn", () => {
    expect(callOpeningClientMessageId("CA123")).toBe(
      "twilio-call:CA123:opening",
    );
    expect(callOpeningClientMessageId("CA123")).not.toBe(
      "twilio-call:CA123:started",
    );
  });

  test("converges a delayed pre-cutoff write on the first claimed opener", async () => {
    let persisted: InboundCallOpeningClaim | undefined;
    const persistFirstWriter = async (candidate: InboundCallOpeningClaim) => {
      persisted ??= candidate;
      return persisted;
    };
    const firstContext = resolveCallContinuityContext({
      callStartedAt: now,
      historyMessages: [],
    });
    const firstClaim = await claimInboundCallOpeningContext(
      {
        id: "call-record-1",
        receivedAt: new Date(now),
        ...firstContext,
      },
      persistFirstWriter,
    );

    const delayedPriorInteractionAt = now - 1;
    const changedCandidate = resolveCallContinuityContext({
      callStartedAt: now,
      historyMessages: [{ createdAt: delayedPriorInteractionAt }],
    });
    expect(changedCandidate).toEqual({
      returningCaller: true,
      previousInteractionAt: delayedPriorInteractionAt,
    });
    const duplicateClaim = await claimInboundCallOpeningContext(
      {
        id: "call-record-2",
        receivedAt: new Date(now),
        ...changedCandidate,
      },
      persistFirstWriter,
    );
    expect(duplicateClaim).toEqual(firstClaim);

    const firstPrompt = callOpeningPrompt(
      firstClaim.returningCaller,
      firstClaim.previousInteractionAt,
      firstClaim.receivedAt.getTime(),
    );
    const duplicatePrompt = callOpeningPrompt(
      duplicateClaim.returningCaller,
      duplicateClaim.previousInteractionAt,
      duplicateClaim.receivedAt.getTime(),
    );
    expect(duplicatePrompt).toBe(firstPrompt);
    expect(callOpeningClientMessageId("CA123")).toBe(
      "twilio-call:CA123:opening",
    );
  });

  test("fails when the durable opening claim returns no winner", async () => {
    await expect(
      claimInboundCallOpeningContext(
        {
          id: "call-record-missing",
          receivedAt: new Date(now),
          returningCaller: false,
          previousInteractionAt: undefined,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "TWILIO_CALL_OPENING_CONTEXT_UNAVAILABLE",
    });
  });

  test("keeps legacy history without timestamps returning but age-unknown", () => {
    expect(
      resolveCallContinuityContext({
        callStartedAt: now,
        historyMessages: [{}, { createdAt: now + 1_000 }],
      }),
    ).toEqual({ returningCaller: true, previousInteractionAt: undefined });
  });

  test("sanitizes teardown reasons", () => {
    expect(callEndedEvent("client disconnect! token=secret")).toBe(
      "Call lifecycle event: the phone call ended (client_disconnect__token_secret).",
    );
  });

  test("starts prewarm before lifecycle persistence and joins both", async () => {
    const started: string[] = [];
    let finishPrewarm: () => void = () => undefined;
    let finishLifecycle: () => void = () => undefined;
    const task = prewarmAndRecordVoiceCallStart(
      () =>
        new Promise<void>((resolve) => {
          started.push("prewarm");
          finishPrewarm = resolve;
        }),
      () =>
        new Promise<void>((resolve) => {
          started.push("lifecycle");
          finishLifecycle = resolve;
        }),
    );

    expect(started).toEqual(["prewarm", "lifecycle"]);
    finishLifecycle();
    await Promise.resolve();
    let completed = false;
    void task.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    finishPrewarm();
    await task;
    expect(completed).toBe(true);
  });
});
