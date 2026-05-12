/**
 * W3-B synthetic-fail tests for the prompt-content lint pass.
 *
 * Verifies the linter flags every rule in the documented corpus
 * (`docs/audit/prompt-content-lint.md`) — including the W3-B additions
 * (email PII, phone PII, hardcoded URL, Wave-N narrative, prompt slop) and
 * the existing rules (PII name, absolute path, hardcoded ISO time,
 * embedded conditional).
 *
 * The runner script (`scripts/lint-default-packs.mjs`) exits non-zero on
 * any finding. This file pins the runtime entry point (`lintPromptText` /
 * `lintPack`) — which is what runs from in-process pack registration — to
 * the same corpus.
 *
 * Fixtures are constructed inline so the test stays independent of the
 * shipped `src/default-packs/*.ts` content. The shipped-pack-clean
 * assertion lives in `default-packs.lint.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  type DefaultPack,
  lintPack,
  lintPromptText,
  type PromptLintRuleKind,
  type ScheduledTaskSeed,
} from "../src/default-packs/index.js";

function buildSeed(prompt: string, recordKey: string): ScheduledTaskSeed {
  return {
    kind: "reminder",
    promptInstructions: prompt,
    trigger: { kind: "manual" },
    priority: "low",
    respectsGlobalPause: true,
    source: "default_pack",
    createdBy: "synthetic-fail-test",
    ownerVisible: true,
    metadata: { recordKey },
  };
}

function buildPack(prompt: string): DefaultPack {
  return {
    key: "synthetic-fail-fixture",
    label: "synthetic",
    description: "fixture pack used by W3-B synthetic-fail tests",
    defaultEnabled: false,
    records: [buildSeed(prompt, "synthetic-record")],
  };
}

interface SyntheticCase {
  readonly name: string;
  readonly rule: PromptLintRuleKind;
  readonly prompt: string;
}

/**
 * One case per rule kind. Each case must independently produce its rule's
 * finding when run through `lintPromptText`.
 */
const SYNTHETIC_CASES: ReadonlyArray<SyntheticCase> = [
  {
    name: "PII name",
    rule: "pii_name",
    prompt: "Reply to Samantha kindly.",
  },
  {
    name: "email PII",
    rule: "email_pii",
    prompt: "Send the brief to owner.account@example.com promptly.",
  },
  {
    name: "phone PII",
    rule: "phone_pii",
    prompt: "Call the owner at +1 415-555-0123 if they don't reply.",
  },
  {
    name: "absolute path",
    rule: "absolute_path",
    prompt: "Save the brief to /Users/owner/notes/today.md.",
  },
  {
    name: "hardcoded ISO time (clock)",
    rule: "hardcoded_iso_time",
    prompt: "Fire at 08:00 on weekdays.",
  },
  {
    name: "hardcoded ISO datetime",
    rule: "hardcoded_iso_time",
    prompt: "Schedule the message for 2026-01-15T07:00:00Z.",
  },
  {
    name: "embedded conditional (if user)",
    rule: "embedded_conditional",
    prompt: "if user has not replied, send a follow-up.",
  },
  {
    name: "embedded conditional (unless owner)",
    rule: "embedded_conditional",
    prompt: "unless owner replied within an hour, escalate.",
  },
  {
    name: "embedded conditional (else if)",
    rule: "embedded_conditional",
    prompt:
      "Send the morning brief; else if there is no data, send a check-in.",
  },
  {
    name: "embedded conditional (case ... when)",
    rule: "embedded_conditional",
    prompt: "case status when paused: skip the reminder.",
  },
  {
    name: "hardcoded URL",
    rule: "hardcoded_url",
    prompt: "Open the dashboard at https://example.com/dashboard for context.",
  },
  {
    name: "Wave narrative (Wave-1)",
    rule: "wave_narrative",
    prompt: "This is a Wave-1 stub; replace with the real briefing.",
  },
  {
    name: "Wave narrative (W3-B)",
    rule: "wave_narrative",
    prompt: "W3-B will tighten this prompt later.",
  },
  {
    name: "prompt slop (TODO)",
    rule: "prompt_slop",
    prompt: "Send a check-in. TODO: include the wins section.",
  },
  {
    name: "prompt slop (FIXME)",
    rule: "prompt_slop",
    prompt: "Send a check-in. FIXME the briefing assembler is unstable.",
  },
];

describe("W3-B prompt-content lint — synthetic-fail corpus (lintPromptText)", () => {
  for (const testCase of SYNTHETIC_CASES) {
    it(`flags ${testCase.name} as ${testCase.rule}`, () => {
      const findings = lintPromptText({
        packKey: "synthetic",
        recordKey: "synthetic-record",
        prompt: testCase.prompt,
      });
      const matched = findings.filter(
        (finding) => finding.rule === testCase.rule,
      );
      expect(matched.length).toBeGreaterThan(0);
    });
  }
});

describe("W3-B prompt-content lint — synthetic-fail corpus (lintPack)", () => {
  for (const testCase of SYNTHETIC_CASES) {
    it(`flags ${testCase.name} when run through lintPack`, () => {
      const pack = buildPack(testCase.prompt);
      const findings = lintPack(pack);
      const matched = findings.filter(
        (finding) => finding.rule === testCase.rule,
      );
      expect(matched.length).toBeGreaterThan(0);
    });
  }

  it("flags every documented rule when one fixture combines them all", () => {
    const combined =
      "If user is Samantha, email owner.account@example.com or call +1 415-555-0123. " +
      "Save to /Users/owner/notes.md and fire at 08:00. Open https://example.com. " +
      "Wave-1 TODO: tighten this.";
    const findings = lintPack(buildPack(combined));
    const ruleSet = new Set<PromptLintRuleKind>(findings.map((f) => f.rule));
    expect(ruleSet.has("pii_name")).toBe(true);
    expect(ruleSet.has("email_pii")).toBe(true);
    expect(ruleSet.has("phone_pii")).toBe(true);
    expect(ruleSet.has("absolute_path")).toBe(true);
    expect(ruleSet.has("hardcoded_iso_time")).toBe(true);
    expect(ruleSet.has("embedded_conditional")).toBe(true);
    expect(ruleSet.has("hardcoded_url")).toBe(true);
    expect(ruleSet.has("wave_narrative")).toBe(true);
    expect(ruleSet.has("prompt_slop")).toBe(true);
  });
});

describe("W3-B prompt-content lint — false-positive guards", () => {
  it("does not flag prompts that reference owner-fact time fields", () => {
    const findings = lintPromptText({
      packKey: "synthetic",
      recordKey: "synthetic-record",
      prompt:
        "Use the owner's morningWindow.start (HH:MM format, e.g. 08:00) to anchor the message.",
    });
    expect(findings.filter((f) => f.rule === "hardcoded_iso_time")).toEqual([]);
  });

  it("does not flag email-shaped substrings without a real local@host.tld", () => {
    const findings = lintPromptText({
      packKey: "synthetic",
      recordKey: "synthetic-record",
      prompt: "Reply to the @mention in the inbox without inventing senders.",
    });
    expect(findings.filter((f) => f.rule === "email_pii")).toEqual([]);
  });

  it("does not flag PII substrings inside other words", () => {
    const findings = lintPromptText({
      packKey: "synthetic",
      recordKey: "synthetic-record",
      prompt: "the spinmarcora element should not match",
    });
    expect(findings.filter((f) => f.rule === "pii_name")).toEqual([]);
  });

  it("does not flag bare digit clusters (only formatted phone shapes)", () => {
    const findings = lintPromptText({
      packKey: "synthetic",
      recordKey: "synthetic-record",
      prompt: "Surface the 1234 unread items with the 56 starred follow-ups.",
    });
    expect(findings.filter((f) => f.rule === "phone_pii")).toEqual([]);
  });
});
