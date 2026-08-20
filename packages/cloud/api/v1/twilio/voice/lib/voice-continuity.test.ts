/** Verifies deterministic, privacy-safe phone conversation lifecycle prompts. */

import { describe, expect, test } from "bun:test";
import {
  callEndedEvent,
  callOpeningGreeting,
  callStartedEvent,
  prewarmAndRecordVoiceCallStart,
  relativeInteractionAge,
} from "./voice-continuity";

describe("voice continuity", () => {
  const now = Date.UTC(2026, 7, 15, 12);

  test("describes first contact without inventing history", () => {
    expect(callStartedEvent(undefined, now)).toContain(
      "first recorded interaction",
    );
  });

  test("bounds prior interaction age into spoken units", () => {
    expect(relativeInteractionAge(now - 3 * 60 * 60_000, now)).toBe("3 hours");
    expect(callStartedEvent(now - 2 * 86_400_000, now)).toContain(
      "about 2 days ago",
    );
  });

  test("uses the exact model-free first and returning call openers", () => {
    expect(callOpeningGreeting(false)).toBe(
      "Hi, it's Eliza. Want help planning today? I can text this call a way to continue afterward.",
    );
    expect(callOpeningGreeting(true)).toBe(
      "Hey, good to hear from you. Want to pick up where we left off?",
    );
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
