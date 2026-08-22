/**
 * Unit coverage for the model-phrasing seam: the phrased happy path, every
 * degrade-to-fallback edge (timeout, throw, empty, banned vocabulary,
 * mustInclude miss, over-length), the machine-appendix byte contract, the
 * voiced-send metadata shape, the LRU memo, and the pure prompt builder.
 * Deterministic: fake runtime, mocked model, no network.
 */

import type { Character, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_VOICED_METADATA,
  BANNED_MECHANISM_VOCAB_RE,
  buildPhrasePrompt,
  characterVoiceSlice,
  phraseForUser,
  validatePhrasedText,
  withMachineAppendix,
} from "./phrase-for-user.js";

const CHARACTER: Character = {
  name: "Eliza",
  bio: ["A helpful runtime companion.", "Loves shipping."],
  adjectives: ["warm", "direct"],
  style: { chat: ["concise"], all: ["sentence case"] },
} as Character;

function makeRuntime(useModel: (...args: unknown[]) => unknown): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-0000000000aa",
    character: CHARACTER,
    getSetting: vi.fn(() => undefined),
    useModel: vi.fn(useModel),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

const FRAME = {
  intent: "confirm" as const,
  facts: { createdCount: 2, titles: ["auth refactor", "docs pass"] },
};

describe("phraseForUser", () => {
  it("returns the model's text on the phrased path", async () => {
    const runtime = makeRuntime(async () => "Both tasks are underway.");
    const out = await phraseForUser(runtime, FRAME, "Created 2 task agents.");
    expect(out).toEqual({ text: "Both tasks are underway.", phrased: true });
  });

  it("times out to the fallback without throwing", async () => {
    const runtime = makeRuntime(() => new Promise(() => {}));
    const out = await phraseForUser(runtime, FRAME, "Created 2 task agents.", {
      timeoutMs: 10,
    });
    expect(out).toEqual({ text: "Created 2 task agents.", phrased: false });
  });

  it("a model throw degrades to the fallback", async () => {
    const runtime = makeRuntime(async () => {
      throw new Error("provider down");
    });
    const out = await phraseForUser(runtime, FRAME, "Created 2 task agents.");
    expect(out).toEqual({ text: "Created 2 task agents.", phrased: false });
  });

  it("a missing useModel degrades to the fallback (never throws)", async () => {
    const runtime = {
      agentId: "a",
      character: CHARACTER,
    } as unknown as IAgentRuntime;
    const out = await phraseForUser(runtime, FRAME, "fallback facts");
    expect(out).toEqual({ text: "fallback facts", phrased: false });
  });

  it("empty model output degrades to the fallback", async () => {
    const runtime = makeRuntime(async () => "   ");
    const out = await phraseForUser(runtime, FRAME, "fallback facts");
    expect(out.phrased).toBe(false);
  });

  it("a mustInclude miss (case-sensitive) degrades to the fallback", async () => {
    const runtime = makeRuntime(async () => "Opened issue #7 for you.");
    const out = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: { number: 7 },
        mustInclude: ["#7", "https://github.com/o/r/issues/7"],
      },
      "Created issue #7: https://github.com/o/r/issues/7",
    );
    expect(out.phrased).toBe(false);
    expect(out.text).toContain("https://github.com/o/r/issues/7");
  });

  it("keeps model text that carries every mustInclude value verbatim", async () => {
    const runtime = makeRuntime(
      async () => "Done — issue #7 is up: https://github.com/o/r/issues/7",
    );
    const out = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: { number: 7 },
        mustInclude: ["#7", "https://github.com/o/r/issues/7"],
      },
      "Created issue #7: https://github.com/o/r/issues/7",
    );
    expect(out.phrased).toBe(true);
  });

  it("banned internal-mechanism vocabulary degrades to the fallback", async () => {
    for (const leak of [
      "The session is running now.",
      "I got a receipt for that.",
      "The orchestrator kicked it off.",
      "My planner scheduled it.",
      "ACP is connected.",
      "The callback fired.",
      "Tracking uuid abc.",
    ]) {
      const runtime = makeRuntime(async () => leak);
      const out = await phraseForUser(runtime, FRAME, "fallback facts");
      expect(out, leak).toEqual({ text: "fallback facts", phrased: false });
    }
  });

  it("over-length output degrades to the fallback", async () => {
    const runtime = makeRuntime(async () => "x".repeat(500));
    const out = await phraseForUser(runtime, FRAME, "fallback facts", {
      maxChars: 320,
    });
    expect(out.phrased).toBe(false);
  });

  it("strips one pair of surrounding quotes before validating", async () => {
    const runtime = makeRuntime(async () => '"Both tasks are underway."');
    const out = await phraseForUser(runtime, FRAME, "fallback facts");
    expect(out).toEqual({ text: "Both tasks are underway.", phrased: true });
  });

  it("never makes a second model call for a failed frame", async () => {
    const useModel = vi.fn(async () => "the session leaked");
    const runtime = makeRuntime(useModel);
    await phraseForUser(runtime, FRAME, "fallback facts");
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("memoizes repeated frames by cacheKey and skips the model on a hit", async () => {
    const useModel = vi.fn(async () => "Heads up — nearly at the limit.");
    const runtime = makeRuntime(useModel);
    const first = await phraseForUser(runtime, FRAME, "fallback", {
      cacheKey: "capwarn:test-memo-1",
    });
    const second = await phraseForUser(runtime, FRAME, "fallback", {
      cacheKey: "capwarn:test-memo-1",
    });
    expect(first.phrased).toBe(true);
    expect(second).toEqual(first);
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("never caches fallbacks — the next call retries the model", async () => {
    const useModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("Back up and phrased.");
    const runtime = makeRuntime(useModel);
    const first = await phraseForUser(runtime, FRAME, "fallback", {
      cacheKey: "capwarn:test-memo-2",
    });
    const second = await phraseForUser(runtime, FRAME, "fallback", {
      cacheKey: "capwarn:test-memo-2",
    });
    expect(first.phrased).toBe(false);
    expect(second).toEqual({ text: "Back up and phrased.", phrased: true });
  });
});

describe("withMachineAppendix", () => {
  it("keeps the appendix byte-identical below the prose", () => {
    const appendix = `[TASK:abc-123]Fix the auth bug[/TASK]`;
    const out = withMachineAppendix("On it.", appendix);
    expect(out).toBe(`On it.\n\n${appendix}`);
    expect(out.endsWith(appendix)).toBe(true);
  });
});

describe("AGENT_VOICED_METADATA", () => {
  it("is the exact spreadable voice-gate marker", () => {
    expect(AGENT_VOICED_METADATA).toEqual({ agentVoiced: true });
    expect({ text: "x", ...AGENT_VOICED_METADATA }).toMatchObject({
      agentVoiced: true,
    });
  });
});

describe("buildPhrasePrompt / characterVoiceSlice", () => {
  it("derives voice from the character (name, bio, deduped traits)", () => {
    const slice = characterVoiceSlice(CHARACTER);
    expect(slice).toContain("You are Eliza.");
    expect(slice).toContain("A helpful runtime companion.");
    expect(slice).toContain("Voice: warm, direct, concise, sentence case.");
  });

  it("includes EVERY bio line and EVERY deduped trait — no slice", () => {
    const bio = Array.from({ length: 6 }, (_, i) => `Bio line ${i + 1}.`);
    const adjectives = Array.from({ length: 12 }, (_, i) => `trait${i + 1}`);
    const slice = characterVoiceSlice({
      name: "Eliza",
      bio,
      adjectives,
      style: { chat: ["chatty"], all: ["lowercase-never"] },
    } as Character);
    for (const line of bio) expect(slice).toContain(line);
    for (const trait of adjectives) expect(slice).toContain(trait);
    expect(slice).toContain("chatty");
    expect(slice).toContain("lowercase-never");
  });

  it("rides fact values into the prompt COMPLETE — no 400-char clip", () => {
    const longValue = `start-${"x".repeat(600)}-end`;
    const prompt = buildPhrasePrompt(
      CHARACTER,
      { intent: "confirm", facts: { task: longValue } },
      320,
    );
    expect(prompt).toContain(`- task: ${longValue}`);
    expect(prompt).not.toContain("…");
  });

  it("carries facts, exact-inclusion quotes, forbidden claims, and rules", () => {
    const prompt = buildPhrasePrompt(
      CHARACTER,
      {
        intent: "fail",
        facts: { launchedCount: 1, failedLabels: ["docs pass"] },
        mustInclude: ["docs pass"],
        mustNotClaim: ["everything launched"],
      },
      320,
    );
    expect(prompt).toContain("- launchedCount: 1");
    expect(prompt).toContain("- failedLabels: docs pass");
    expect(prompt).toContain('include exactly: "docs pass"');
    expect(prompt).toContain("do not claim: everything launched");
    expect(prompt).toContain("under 320 characters");
    expect(prompt).toContain("Sentence case");
  });
});

describe("validatePhrasedText", () => {
  it("rejects banned vocab and accepts clean prose", () => {
    const req = { intent: "notify" as const, facts: {} };
    expect(validatePhrasedText("All done here.", req, 320)).toBe(true);
    expect(validatePhrasedText("The receipt is in.", req, 320)).toBe(false);
    expect(BANNED_MECHANISM_VOCAB_RE.test("reception desk")).toBe(false);
    expect(BANNED_MECHANISM_VOCAB_RE.test("sessions")).toBe(true);
  });
});
