/** Verifies deterministic, privacy-safe phone conversation lifecycle prompts. */

import { describe, expect, test } from "bun:test";
import {
  callEndedEvent,
  callStartedPrompt,
  relativeInteractionAge,
} from "./voice-continuity";

describe("voice continuity", () => {
  const now = Date.UTC(2026, 7, 15, 12);

  test("describes first contact without inventing history", () => {
    expect(callStartedPrompt(undefined, now)).toContain(
      "first recorded interaction",
    );
  });

  test("bounds prior interaction age into spoken units", () => {
    expect(relativeInteractionAge(now - 3 * 60 * 60_000, now)).toBe("3 hours");
    expect(callStartedPrompt(now - 2 * 86_400_000, now)).toContain(
      "about 2 days ago",
    );
  });

  test("sanitizes teardown reasons", () => {
    expect(callEndedEvent("client disconnect! token=secret")).toBe(
      "Call lifecycle event: the phone call ended (client_disconnect__token_secret).",
    );
  });
});
