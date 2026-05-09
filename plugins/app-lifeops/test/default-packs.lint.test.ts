/**
 * Unit tests for the W1-D prompt-content lint module.
 *
 * Covers the four rule kinds (PII, absolute path, hardcoded ISO time,
 * embedded conditional). Verifies the shipped packs are clean (no findings),
 * and that representative dirty inputs produce findings.
 */

import { describe, expect, it } from "vitest";
import {
  formatFindings,
  getAllDefaultPacks,
  lintPack,
  lintPacks,
  lintPromptText,
} from "../src/default-packs/index.js";

describe("W1-D prompt-content lint — clean shipped packs", () => {
  it("all shipped W1-D packs have zero findings", () => {
    const findings = lintPacks(getAllDefaultPacks());
    if (findings.length > 0) {
      console.error(formatFindings(findings));
    }
    expect(findings).toEqual([]);
  });
});

describe("W1-D prompt-content lint — pii_name rule", () => {
  it("flags Samantha", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "If user is Samantha, do X.",
    });
    expect(findings.some((f) => f.rule === "pii_name")).toBe(true);
  });

  it("flags Jill, Marco, Sarah, Suran", () => {
    for (const name of ["Jill", "Marco", "Sarah", "Suran"]) {
      const findings = lintPromptText({
        packKey: "test",
        recordKey: "test-record",
        prompt: `Reply to ${name} kindly.`,
      });
      expect(findings.some((f) => f.rule === "pii_name")).toBe(true);
    }
  });

  it("does not flag substrings inside other words", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "the spinmarcora element should not match",
    });
    expect(findings.filter((f) => f.rule === "pii_name").length).toBe(0);
  });
});

describe("W1-D prompt-content lint — absolute_path rule", () => {
  it("flags absolute Unix paths", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "Save to /Users/owner/notes/today.md",
    });
    expect(findings.some((f) => f.rule === "absolute_path")).toBe(true);
  });

  it("flags ~/-rooted paths", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "Read from ~/.config/lifeops.json",
    });
    expect(findings.some((f) => f.rule === "absolute_path")).toBe(true);
  });

  it("flags Windows-style paths", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "Use C:\\Users\\Owner\\doc",
    });
    expect(findings.some((f) => f.rule === "absolute_path")).toBe(true);
  });
});

describe("W1-D prompt-content lint — hardcoded_iso_time rule", () => {
  it("flags HH:MM clock time without owner-fact reference", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "Fire at 08:00 every weekday.",
    });
    expect(findings.some((f) => f.rule === "hardcoded_iso_time")).toBe(true);
  });

  it("flags full ISO datetime without owner-fact reference", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "Schedule for 2026-01-15T07:00:00Z",
    });
    expect(findings.some((f) => f.rule === "hardcoded_iso_time")).toBe(true);
  });

  it("does not flag clock times when prompt references morningWindow", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt:
        "Fire at the owner's morningWindow.start (e.g. 08:00 default) — read from owner facts.",
    });
    expect(findings.filter((f) => f.rule === "hardcoded_iso_time").length).toBe(
      0,
    );
  });

  it("does not flag the literal HH:MM placeholder", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "The expected format is HH:MM.",
    });
    expect(findings.filter((f) => f.rule === "hardcoded_iso_time").length).toBe(
      0,
    );
  });
});

describe("W1-D prompt-content lint — embedded_conditional rule", () => {
  it("flags 'if user' branch", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "if user has not replied, send another nudge.",
    });
    expect(findings.some((f) => f.rule === "embedded_conditional")).toBe(true);
  });

  it("flags 'when X = Y' branches", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "when status = paused, skip.",
    });
    expect(findings.some((f) => f.rule === "embedded_conditional")).toBe(true);
  });

  it("flags 'if owner' branch", () => {
    const findings = lintPromptText({
      packKey: "test",
      recordKey: "test-record",
      prompt: "if owner is offline, retry later.",
    });
    expect(findings.some((f) => f.rule === "embedded_conditional")).toBe(true);
  });
});

describe("W1-D prompt-content lint — pack-level lintPack helper", () => {
  it("returns empty findings for a clean pack", () => {
    const cleanPack = {
      key: "test-clean",
      label: "test",
      description: "test",
      defaultEnabled: false,
      records: [
        {
          kind: "reminder" as const,
          promptInstructions:
            "Send a reminder. Reference owner's morningWindow.start for timing.",
          trigger: { kind: "manual" as const },
          priority: "low" as const,
          respectsGlobalPause: true,
          source: "default_pack" as const,
          createdBy: "test",
          ownerVisible: true,
          metadata: { recordKey: "clean-record" },
        },
      ],
    };
    expect(lintPack(cleanPack)).toEqual([]);
  });

  it("returns findings for a dirty pack", () => {
    const dirtyPack = {
      key: "test-dirty",
      label: "test",
      description: "test",
      defaultEnabled: false,
      records: [
        {
          kind: "reminder" as const,
          promptInstructions:
            "If user is Samantha, fire at 08:00 and write to /tmp/foo.",
          trigger: { kind: "manual" as const },
          priority: "low" as const,
          respectsGlobalPause: true,
          source: "default_pack" as const,
          createdBy: "test",
          ownerVisible: true,
          metadata: { recordKey: "dirty-record" },
        },
      ],
    };
    const findings = lintPack(dirtyPack);
    const rules = new Set(findings.map((f) => f.rule));
    expect(rules.has("pii_name")).toBe(true);
    expect(rules.has("hardcoded_iso_time")).toBe(true);
    expect(rules.has("absolute_path")).toBe(true);
  });
});
