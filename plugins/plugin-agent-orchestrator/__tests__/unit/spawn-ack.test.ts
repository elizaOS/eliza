/**
 * spawn-ack.test.ts
 *
 * Unit coverage for the pure pieces of the LLM-generated "ack"-mode spawn
 * acknowledgement (plugins/plugin-agent-orchestrator/src/index.ts). The single
 * `useModel` call that produces the line is impure and covered through the
 * progress-hook harness (progress-cadence.test.ts); the prompt construction and
 * output sanitization are pure and tested directly here.
 *
 * The whole point of this surface is that there is NO hardcoded ack phrase, no
 * i18n table, and no scraped personality: the model writes the line in the
 * character's voice and the user's language. These tests pin the two seams that
 * make that safe — the prompt carries the character + task, and the model's
 * output is reduced to one clean line (with a literal fallback only when the
 * model produces nothing usable).
 */

import type { Character } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildSpawnAckSystemPrompt,
  buildSpawnAckUserPrompt,
  SPAWN_ACK_FALLBACK,
  sanitizeSpawnAck,
} from "../../src/index.js";

describe("buildSpawnAckSystemPrompt", () => {
  it("carries the character name, voice, and the one-line + same-language rules", () => {
    const character: Character = {
      name: "Avery",
      bio: ["a terse, dry on-chain assistant"],
      adjectives: ["dry", "precise"],
      style: { chat: ["casual"], all: ["concise"] },
    };
    const prompt = buildSpawnAckSystemPrompt(character);
    expect(prompt).toContain("You are Avery.");
    expect(prompt).toContain("a terse, dry on-chain assistant");
    // Voice traits are surfaced from the configured character, never hardcoded.
    expect(prompt).toContain("dry");
    expect(prompt).toContain("precise");
    // Hard constraints that keep the output to one short in-language line.
    expect(prompt.toLowerCase()).toContain("one");
    expect(prompt.toLowerCase()).toContain("same language");
    expect(prompt.toLowerCase()).toContain("no emoji");
  });

  it("degrades gracefully for an empty character (no name, no bio, no style)", () => {
    const prompt = buildSpawnAckSystemPrompt({});
    expect(prompt).toContain("You are the assistant.");
    expect(prompt.toLowerCase()).toContain("same language");
    // No dangling "Voice:" header when there are no traits to list.
    expect(prompt).not.toContain("Voice:");
  });

  it("dedupes overlapping traits and bounds the voice descriptor list", () => {
    const character: Character = {
      name: "Bot",
      adjectives: ["calm", "calm", "warm"],
      style: { chat: ["warm", "friendly"], all: ["friendly"] },
    };
    const prompt = buildSpawnAckSystemPrompt(character);
    // "warm"/"friendly" appear once each in the joined voice list despite the
    // duplication across adjectives + style.chat + style.all.
    const voiceLine = prompt.slice(prompt.indexOf("Voice:"));
    expect(voiceLine.match(/warm/g)?.length).toBe(1);
    expect(voiceLine.match(/friendly/g)?.length).toBe(1);
  });
});

describe("buildSpawnAckUserPrompt", () => {
  it("embeds the task verbatim as the language signal", () => {
    const prompt = buildSpawnAckUserPrompt("déploie le site sur Cloudflare");
    expect(prompt).toContain("déploie le site sur Cloudflare");
    expect(prompt).toContain("acknowledgement");
  });

  it("supplies a neutral placeholder when the task is blank", () => {
    const prompt = buildSpawnAckUserPrompt("   ");
    expect(prompt).toContain("the task they just gave you");
  });

  it("clips an overlong task so the prompt stays bounded", () => {
    const long = "x".repeat(1000);
    const prompt = buildSpawnAckUserPrompt(long);
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(500);
  });
});

describe("sanitizeSpawnAck", () => {
  it("returns a clean one-liner unchanged", () => {
    expect(sanitizeSpawnAck("On it — starting now.")).toBe(
      "On it — starting now.",
    );
  });

  it("keeps only the first non-empty line", () => {
    expect(sanitizeSpawnAck("\n\nOkay, getting into it.\nblah blah")).toBe(
      "Okay, getting into it.",
    );
  });

  it("strips a leading emoji and list/quote markers", () => {
    expect(sanitizeSpawnAck("🚀 On it.")).toBe("On it.");
    expect(sanitizeSpawnAck("- On it.")).toBe("On it.");
    expect(sanitizeSpawnAck("> On it.")).toBe("On it.");
  });

  it("strips a single pair of surrounding quotes (straight, smart, backtick)", () => {
    expect(sanitizeSpawnAck('"On it."')).toBe("On it.");
    expect(sanitizeSpawnAck("'On it.'")).toBe("On it.");
    expect(sanitizeSpawnAck("“On it.”")).toBe("On it.");
    expect(sanitizeSpawnAck("`On it.`")).toBe("On it.");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeSpawnAck("On    it    now.")).toBe("On it now.");
  });

  it("preserves non-English output untouched (no language assumptions)", () => {
    expect(sanitizeSpawnAck("C'est parti, je m'y mets.")).toBe(
      "C'est parti, je m'y mets.",
    );
    expect(sanitizeSpawnAck("了解、今すぐ取りかかります。")).toBe(
      "了解、今すぐ取りかかります。",
    );
  });

  it("clips an over-long line and marks the truncation", () => {
    const out = sanitizeSpawnAck("word ".repeat(60));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty (caller falls back) for empty / whitespace-only input", () => {
    expect(sanitizeSpawnAck("")).toBe("");
    expect(sanitizeSpawnAck("   \n  ")).toBe("");
  });
});

describe("SPAWN_ACK_FALLBACK", () => {
  it("is a short, neutral, non-empty literal", () => {
    expect(SPAWN_ACK_FALLBACK.trim().length).toBeGreaterThan(0);
    expect(SPAWN_ACK_FALLBACK.length).toBeLessThanOrEqual(24);
  });
});
