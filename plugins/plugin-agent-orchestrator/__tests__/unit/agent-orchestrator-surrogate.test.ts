/**
 * Verifies that string truncation across agent-orchestrator components
 * (spawn acks, completion summaries, failure reasons, activity summaries,
 * tool outputs, and evidence strings) never splits UTF-16 surrogate pairs
 * and sanitizes lone surrogates before output.
 */

import { describe, expect, it } from "vitest";
import { extractFailureReason } from "../../src/evaluators/sub-agent-failure.js";
import {
  buildSpawnAckUserPrompt,
  extractCompletionSummary,
  sanitizeSpawnAck,
} from "../../src/index.js";
import {
  buildEvidenceStringFromInput,
  clamp,
} from "../../src/services/completion-evidence.js";

describe("agent-orchestrator surrogate safety", () => {
  describe("buildSpawnAckUserPrompt", () => {
    it("never splits surrogate pairs at the 400 char truncation boundary", () => {
      // 396 'a's + 🦊 (2 UTF-16 code units) + 50 'b's = 448 chars
      const task = `${"a".repeat(396)}🦊${"b".repeat(50)}`;
      const prompt = buildSpawnAckUserPrompt(task);
      expect(prompt.isWellFormed()).toBe(true);
      expect(prompt).toContain(`${"a".repeat(396)}…`);
    });

    it("sanitizes lone surrogates", () => {
      const task = `task with bad surrogate ${String.fromCharCode(0xd800)} content`;
      const prompt = buildSpawnAckUserPrompt(task);
      expect(prompt.isWellFormed()).toBe(true);
      expect(prompt).toContain("\uFFFD");
    });
  });

  describe("sanitizeSpawnAck", () => {
    it("never splits surrogate pairs at the SPAWN_ACK_MAX_CHARS boundary", () => {
      // SPAWN_ACK_MAX_CHARS is 120.
      // 118 'a's + 🦊 (2 code units) + 20 'b's = 140 chars
      const ack = `${"a".repeat(118)}🦊${"b".repeat(20)}`;
      const sanitized = sanitizeSpawnAck(ack);
      expect(sanitized.isWellFormed()).toBe(true);
      expect(sanitized).toBe(`${"a".repeat(118)}…`);
      expect(sanitized.length).toBe(119);
    });

    it("sanitizes lone surrogates and preserves fitting emoji", () => {
      const ack = `I'm starting the task 🚀 ${String.fromCharCode(0xd800)}`;
      const sanitized = sanitizeSpawnAck(ack);
      expect(sanitized.isWellFormed()).toBe(true);
      expect(sanitized).toContain("🚀");
      expect(sanitized).toContain("\uFFFD");
    });
  });

  describe("extractCompletionSummary", () => {
    it("never splits surrogate pairs at the 300 char truncation boundary", () => {
      // 296 'a's + 🦊 (2 code units) + 50 'b's = 348 chars
      const raw = `${"a".repeat(296)}🦊${"b".repeat(50)}`;
      const summary = extractCompletionSummary(raw);
      expect(summary.isWellFormed()).toBe(true);
      expect(summary).toBe(`${"a".repeat(296)}…`);
    });

    it("handles lone surrogates cleanly", () => {
      const raw = `Completed task with ${String.fromCharCode(0xd83d)} item`;
      const summary = extractCompletionSummary(raw);
      expect(summary.isWellFormed()).toBe(true);
      expect(summary).toContain("\uFFFD");
    });
  });

  describe("extractFailureReason", () => {
    it("never splits surrogate pairs at the 160 char truncation boundary", () => {
      // 156 'a's + 🦊 (2 code units) + 30 'b's
      const errorOutput = `Error occurred: ${"a".repeat(156)}🦊${"b".repeat(30)}`;
      const reason = extractFailureReason(errorOutput);
      expect(reason.isWellFormed()).toBe(true);
      expect(reason.length).toBeLessThanOrEqual(158);
    });
  });

  describe("completion-evidence clamp and assembly", () => {
    it("never splits surrogate pairs at the clamp boundary", () => {
      const text = `${"a".repeat(99)}🦊${"b".repeat(20)}`;
      const clamped = clamp(text, 100);
      expect(clamped.isWellFormed()).toBe(true);
      expect(clamped).toContain(`${"a".repeat(99)}\n… [truncated]`);
    });

    it("preserves well-formed Unicode in buildEvidenceStringFromInput", () => {
      const input = {
        fallbackSummary: "done 🚀",
        deliverable: `${"x".repeat(100)} 🦊 ${"y".repeat(100)}`,
        finalReply: `Fixed everything ✨ ${String.fromCharCode(0xd800)}`,
      };
      const evidence = buildEvidenceStringFromInput(input);
      expect(evidence.isWellFormed()).toBe(true);
      expect(evidence).toContain("🦊");
      expect(evidence).toContain("✨");
      expect(evidence).toContain("\uFFFD");
    });
  });
});
