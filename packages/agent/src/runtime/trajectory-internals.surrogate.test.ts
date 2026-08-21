/**
 * Surrogate-safe truncation for trajectory-internals.
 *
 * These tests drive the REAL exported helpers from `trajectory-internals.ts`.
 * The previous revision of this file re-declared the clamps locally and never
 * imported the module under test, so every production truncation site in it
 * could be replaced by a raw `.slice()` while the suite stayed green.
 */

import { createHash } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { TRAJECTORY_STEP_SCRIPT_MAX_CHARS } from "../types/trajectory.ts";
import {
  capScriptForPersistence,
  extractInsightsFromResponse,
  flushObservationBuffer,
  pushChatExchange,
  truncateField,
  truncateRecord,
} from "./trajectory-internals.ts";

const FOX = "🦊";
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);

function isWellFormed(value: string): boolean {
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}

describe("truncateField", () => {
  it("keeps the head cut well-formed across every astral offset", () => {
    for (let n = 0; n <= 8; n++) {
      const input = `${"a".repeat(496 + n)}${FOX}${"b".repeat(3000)}`;
      const out = truncateField(input, 500);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("keeps the tail cut well-formed across every astral offset", () => {
    for (let n = 0; n <= 8; n++) {
      const input = `${"a".repeat(3000)}${FOX}${"b".repeat(496 + n)}`;
      const out = truncateField(input, 500);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("splits neither end when a pair straddles both boundaries at once", () => {
    const input = `${"a".repeat(499)}${FOX}${"b".repeat(2000)}${FOX}${"c".repeat(499)}`;
    const out = truncateField(input, 500);
    expect(isWellFormed(out)).toBe(true);
    // Head backs off to 499 "a"; tail backs off to 499 "c".
    expect(out.startsWith(`${"a".repeat(499)}\n`)).toBe(true);
    expect(out.endsWith(`\n${"c".repeat(499)}`)).toBe(true);
  });

  it("reports a truthful removed-character count after a back-off", () => {
    const input = `${"a".repeat(499)}${FOX}${"b".repeat(2000)}${FOX}${"c".repeat(499)}`;
    const out = truncateField(input, 500);
    const removed = Number(/truncated (\d+) chars/.exec(out)?.[1]);
    const kept = out.length - `\n[...truncated ${removed} chars...]\n`.length;
    expect(kept + removed).toBe(input.length);
  });

  it("is byte-identical to a raw head/tail slice for ASCII input", () => {
    const input = `${"a".repeat(700)}${"b".repeat(700)}`;
    const legacy = `${input.slice(0, 500)}\n[...truncated ${input.length - 1000} chars...]\n${input.slice(-500)}`;
    expect(truncateField(input, 500)).toBe(legacy);
  });

  it("is byte-identical to a raw head/tail slice for BMP input", () => {
    const input = `${"é".repeat(700)}${"漢".repeat(700)}`;
    const legacy = `${input.slice(0, 500)}\n[...truncated ${input.length - 1000} chars...]\n${input.slice(-500)}`;
    expect(truncateField(input, 500)).toBe(legacy);
  });

  it("returns short input unchanged", () => {
    expect(truncateField("short", 500)).toBe("short");
    expect(truncateField(`ok ${FOX}`, 500)).toBe(`ok ${FOX}`);
  });

  it("preserves an astral pair that fits inside the head budget", () => {
    const input = `${"a".repeat(498)}${FOX}${"b".repeat(3000)}`;
    const out = truncateField(input, 500);
    expect(out.startsWith(`${"a".repeat(498)}${FOX}\n`)).toBe(true);
  });

  it("repairs a pre-existing lone surrogate instead of persisting it", () => {
    const input = `hi ${HIGH} there${"a".repeat(2000)}`;
    const out = truncateField(input, 500);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(isWellFormed(truncateField(`lo ${LOW} there`, 500))).toBe(true);
  });
});

describe("truncateRecord", () => {
  it("emits a well-formed serialized payload at every astral offset", () => {
    for (let n = 0; n <= 8; n++) {
      const obj = { k: `${"x".repeat(490 + n)}${FOX}${"y".repeat(3000)}` };
      const out = truncateRecord(obj, 500) as { _truncated: string };
      expect(isWellFormed(out._truncated)).toBe(true);
      expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    }
  });

  it("returns the original object when it fits", () => {
    const obj = { k: "small" };
    expect(truncateRecord(obj, 500)).toBe(obj);
  });
});

describe("capScriptForPersistence", () => {
  it("never stores a lone surrogate at the 4096 cap", () => {
    for (let n = 0; n <= 8; n++) {
      const script = `${"a".repeat(TRAJECTORY_STEP_SCRIPT_MAX_CHARS - 4 + n)}${FOX}${"b".repeat(500)}`;
      const capped = capScriptForPersistence(script);
      expect(isWellFormed(capped.script)).toBe(true);
      // steps_json is a raw JSON.stringify of the step list — a split pair
      // would be written to the row as a \uD8xx escape.
      expect(JSON.stringify(capped.script)).not.toMatch(
        /\\ud[89ab][0-9a-f]{2}/i,
      );
    }
  });

  it("stores a genuine prefix of the hashed source", () => {
    const script = `${"a".repeat(TRAJECTORY_STEP_SCRIPT_MAX_CHARS - 1)}${FOX}${"b".repeat(500)}`;
    const capped = capScriptForPersistence(script);
    expect(script.startsWith(capped.script)).toBe(true);
    expect(capped.scriptHash).toBe(
      createHash("sha256").update(script, "utf8").digest("hex"),
    );
  });

  it("caps ASCII scripts at exactly the documented character budget", () => {
    const script = "a".repeat(TRAJECTORY_STEP_SCRIPT_MAX_CHARS + 100);
    const capped = capScriptForPersistence(script);
    expect(capped.script).toBe(
      script.slice(0, TRAJECTORY_STEP_SCRIPT_MAX_CHARS),
    );
    expect(capped.script.length).toBe(TRAJECTORY_STEP_SCRIPT_MAX_CHARS);
  });

  it("passes a script under the cap through untouched and unhashed", () => {
    const script = `console.log("${FOX}")`;
    const capped = capScriptForPersistence(script);
    expect(capped.script).toBe(script);
    expect(capped.scriptHash).toBeUndefined();
  });
});

describe("extractInsightsFromResponse", () => {
  it("does not split an astral pair at the 100k response clamp", () => {
    // Lay a DECISION line so the 100_000 clamp lands between the two halves
    // of FOX: a raw slice yields an insight ending in a lone high surrogate.
    let response = `${"a".repeat(99_000)}\nDECISION: `;
    response += "b".repeat(99_999 - response.length);
    response += `${FOX}\n`;
    const insights = extractInsightsFromResponse(response, "turn-complete");
    expect(insights).toHaveLength(1);
    for (const insight of insights) {
      expect(isWellFormed(insight)).toBe(true);
      expect(() => JSON.stringify(insight)).not.toThrow();
    }
  });

  it("returns ASCII decisions unchanged", () => {
    expect(
      extractInsightsFromResponse("DECISION: ship it\n", "coordination"),
    ).toEqual(["ship it"]);
  });
});

describe("flushObservationBuffer", () => {
  function stubRuntime(
    modelOutput: string,
    seenPrompts: string[] = [],
  ): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      adapter: { db: { execute: async () => ({ rows: [] }) } },
      useModel: async (_type: unknown, params: { prompt: string }) => {
        seenPrompts.push(params.prompt);
        return modelOutput;
      },
    } as unknown as IAgentRuntime;
  }

  it("clamps buffered exchanges into a well-formed extraction prompt", async () => {
    const seenPrompts: string[] = [];
    const runtime = stubRuntime(JSON.stringify(["ok"]), seenPrompts);
    pushChatExchange(runtime, {
      userPrompt: `${"u".repeat(499)}${FOX}${"v".repeat(200)}`,
      response: `${"r".repeat(499)}${FOX}${"s".repeat(200)}`,
      trajectoryId: "00000000-0000-0000-0000-0000000000cc",
      timestamp: Date.now(),
    });
    await flushObservationBuffer(runtime);
    expect(seenPrompts).toHaveLength(1);
    expect(isWellFormed(seenPrompts[0] as string)).toBe(true);
    expect(() => JSON.stringify(seenPrompts[0])).not.toThrow();
  });

  it("clamps model-authored observations without splitting an astral pair", async () => {
    const observation = `${"o".repeat(149)}${FOX}${"p".repeat(200)}`;
    const runtime = stubRuntime(JSON.stringify([observation]));
    pushChatExchange(runtime, {
      userPrompt: `ask ${FOX}`,
      response: `reply ${FOX}`,
      trajectoryId: "00000000-0000-0000-0000-0000000000aa",
      timestamp: Date.now(),
    });
    const observations = await flushObservationBuffer(runtime);
    expect(observations).toHaveLength(1);
    const only = observations[0] as string;
    expect(isWellFormed(only)).toBe(true);
    expect(only.length).toBeLessThanOrEqual(150);
    expect(() => JSON.stringify(only)).not.toThrow();
  });

  it("leaves ASCII observations clamped exactly as before", async () => {
    const observation = "o".repeat(300);
    const runtime = stubRuntime(JSON.stringify([observation]));
    pushChatExchange(runtime, {
      userPrompt: "ask",
      response: "reply",
      trajectoryId: "00000000-0000-0000-0000-0000000000bb",
      timestamp: Date.now(),
    });
    const observations = await flushObservationBuffer(runtime);
    expect(observations).toEqual([observation.slice(0, 150)]);
  });
});
