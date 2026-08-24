/**
 * Unit coverage for the canonical first-run copy: the two opening onboarding
 * turns seeded verbatim into the chat overlay transcript and the conductor
 * prompts. Pure exported string constants, no DOM or runtime.
 */

import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "./first-run-greeting";

describe("FIRST_RUN_GREETING", () => {
  it("is the exact canonical greeting shown as the first turn", () => {
    expect(FIRST_RUN_GREETING).toBe("Hi, I'm Eliza.");
  });
});

describe("FIRST_RUN_SIGN_IN_PROMPT", () => {
  it("is the exact canonical sign-in prompt shown as the second turn", () => {
    expect(FIRST_RUN_SIGN_IN_PROMPT).toBe("Let's get you signed in.");
  });
});

describe("canonical copy contract", () => {
  it("exposes two distinct non-empty strings safe to seed as message content", () => {
    expect(typeof FIRST_RUN_GREETING).toBe("string");
    expect(typeof FIRST_RUN_SIGN_IN_PROMPT).toBe("string");
    expect(FIRST_RUN_GREETING.length).toBeGreaterThan(0);
    expect(FIRST_RUN_SIGN_IN_PROMPT.length).toBeGreaterThan(0);
    expect(FIRST_RUN_GREETING).not.toBe(FIRST_RUN_SIGN_IN_PROMPT);
  });

  it("renders verbatim with no surrounding whitespace", () => {
    expect(FIRST_RUN_GREETING).toBe(FIRST_RUN_GREETING.trim());
    expect(FIRST_RUN_SIGN_IN_PROMPT).toBe(FIRST_RUN_SIGN_IN_PROMPT.trim());
  });
});
