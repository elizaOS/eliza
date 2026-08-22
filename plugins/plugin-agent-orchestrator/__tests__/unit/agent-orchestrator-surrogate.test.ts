/**
 * Verifies that complete strings across agent-orchestrator components
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
  normalizeEvidenceText,
} from "../../src/services/completion-evidence.js";

describe("agent-orchestrator surrogate safety", () => {
  describe("buildSpawnAckUserPrompt", () => {
    it("preserves the complete task across the former 400-character boundary", () => {
      const task = `${"a".repeat(396)}🦊${"b".repeat(50)}`;
      const prompt = buildSpawnAckUserPrompt(task);
      expect(prompt.isWellFormed()).toBe(true);
      expect(prompt).toContain(task);
    });

    it("sanitizes lone surrogates", () => {
      const task = `task with bad surrogate ${String.fromCharCode(0xd800)} content`;
      const prompt = buildSpawnAckUserPrompt(task);
      expect(prompt.isWellFormed()).toBe(true);
      expect(prompt).toContain("\uFFFD");
    });
  });

  describe("sanitizeSpawnAck", () => {
    it("preserves a complete acknowledgement beyond the former boundary", () => {
      const ack = `${"a".repeat(118)}🦊${"b".repeat(20)}`;
      const sanitized = sanitizeSpawnAck(ack);
      expect(sanitized.isWellFormed()).toBe(true);
      expect(sanitized).toBe(ack);
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
    it("preserves a complete result beyond the former 300-character boundary", () => {
      const raw = `${"a".repeat(296)}🦊${"b".repeat(50)}`;
      const summary = extractCompletionSummary(raw);
      expect(summary.isWellFormed()).toBe(true);
      expect(summary).toBe(raw);
    });

    it("handles lone surrogates cleanly", () => {
      const raw = `Completed task with ${String.fromCharCode(0xd83d)} item`;
      const summary = extractCompletionSummary(raw);
      expect(summary.isWellFormed()).toBe(true);
      expect(summary).toContain("\uFFFD");
    });
  });

  describe("extractFailureReason", () => {
    it("preserves the complete first readable failure line", () => {
      const errorOutput = `Error occurred: ${"a".repeat(156)}🦊${"b".repeat(30)}`;
      const reason = extractFailureReason(errorOutput);
      expect(reason.isWellFormed()).toBe(true);
      expect(reason).toBe(errorOutput);
    });
  });

  describe("completion-evidence normalization and assembly", () => {
    it("preserves a complete well-formed string", () => {
      const text = `${"a".repeat(99)}🦊${"b".repeat(20)}`;
      const normalized = normalizeEvidenceText(text);
      expect(normalized.isWellFormed()).toBe(true);
      expect(normalized).toBe(text);
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
