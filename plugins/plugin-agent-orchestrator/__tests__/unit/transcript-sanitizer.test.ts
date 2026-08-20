/**
 * Unit tests for the shared relay sanitizer (issue elizaOS/eliza#11578).
 *
 * The swarm-synthesis relay path posted sub-agent finalText VERBATIM to the
 * connector, leaking the orchestrator's own `[tool output: …]` envelope blocks
 * to the user. This module centralizes stripping them; these tests pin the
 * robustness cases (empty titles, unterminated blocks, multiple blocks, long
 * remnants) that the router-private copy did not cover.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_RELAY_CHARS,
  elideLongBlocks,
  sanitizeCompletionRelay,
  stripToolTranscript,
} from "../../src/services/transcript-sanitizer.ts";

describe("stripToolTranscript", () => {
  it("strips a normal well-formed envelope block, keeping prose", () => {
    const input =
      "Done building the app.\n" +
      "[tool output: bash]\n$ ls\nfile.txt\n[/tool output]\n" +
      "All set.";
    const out = stripToolTranscript(input);
    expect(out).toContain("Done building the app.");
    expect(out).toContain("All set.");
    expect(out).not.toContain("[tool output:");
    expect(out).not.toContain("[/tool output]");
    expect(out).not.toContain("file.txt");
  });

  it("strips an empty-title envelope block", () => {
    const input =
      'prefix\n[tool output: ""]\nsecret body\n[/tool output]\nsuffix';
    const out = stripToolTranscript(input);
    expect(out).toContain("prefix");
    expect(out).toContain("suffix");
    expect(out).not.toContain("secret body");
    expect(out).not.toContain("tool output");
  });

  it("strips a bare-colon empty-title envelope block", () => {
    const input = "a\n[tool output:]\nbody\n[/tool output]\nb";
    const out = stripToolTranscript(input);
    expect(out).toBe("a\n\nb");
  });

  it("strips MULTIPLE envelope blocks", () => {
    const input =
      "start\n" +
      "[tool output: one]\naaa\n[/tool output]\n" +
      "middle\n" +
      "[tool output: two]\nbbb\n[/tool output]\n" +
      "end";
    const out = stripToolTranscript(input);
    expect(out).toContain("start");
    expect(out).toContain("middle");
    expect(out).toContain("end");
    expect(out).not.toContain("aaa");
    expect(out).not.toContain("bbb");
    expect(out).not.toContain("[tool output:");
  });

  it("strips an UNTERMINATED trailing block to end of string", () => {
    const input =
      "here is the result\n[tool output: truncated]\nhalf a body that never closes";
    const out = stripToolTranscript(input);
    expect(out).toBe("here is the result");
    expect(out).not.toContain("[tool output:");
    expect(out).not.toContain("half a body");
  });

  it("preserves prose and plain URLs", () => {
    const input =
      "PR opened: https://github.com/elizaos/eliza/pull/123 — see the diff.";
    const out = stripToolTranscript(input);
    expect(out).toBe(input.trim());
    expect(out).toContain("https://github.com/elizaos/eliza/pull/123");
  });

  it("returns empty string for empty input", () => {
    expect(stripToolTranscript("")).toBe("");
  });
});

describe("elideLongBlocks", () => {
  it("passes short text through unchanged", () => {
    expect(elideLongBlocks("short", 2000)).toBe("short");
  });

  it("TRUNCATES an over-cap remnant, preserving the head (#11605 destroyed it)", () => {
    // Regression for 37813124bf (#11605): a legit long deliverable (pure
    // prose, no envelopes) was hard-REPLACED by the elision marker — total
    // data loss. It must instead relay the head plus a truncation marker.
    const prose = "Step 1: back up the database. ".repeat(100); // 3000 chars
    const out = elideLongBlocks(prose);
    expect(out).not.toBe(`[output elided — ${prose.length} chars]`);
    expect(out.startsWith("Step 1: back up the database.")).toBe(true);
    expect(out).toContain(`${prose.length} chars total]`);
  });

  it("bounds the truncated result to the cap", () => {
    const big = "x".repeat(DEFAULT_MAX_RELAY_CHARS + 500);
    const out = elideLongBlocks(big);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_RELAY_CHARS);
    expect(out).toContain(`${big.length} chars total]`);
  });

  it("is idempotent: re-sanitizing truncated output is a no-op (buildTaskResultLine re-applies it)", () => {
    const big = "w".repeat(5000);
    const once = elideLongBlocks(big);
    expect(elideLongBlocks(once)).toBe(once);
  });

  it("keeps text exactly at the cap", () => {
    const exact = "y".repeat(DEFAULT_MAX_RELAY_CHARS);
    expect(elideLongBlocks(exact)).toBe(exact);
  });
});

describe("sanitizeCompletionRelay", () => {
  it("keeps human prose but strips the machine CompletionEnvelope and paths", () => {
    const input = [
      "The script now prints the prime numbers through 31.",
      "",
      "```json",
      JSON.stringify({
        diffSummary: "updated prime checker",
        filesChanged: ["prime_checker.py"],
        realWorkdir: "/private/workspaces/task-123",
        verifiedChangedFiles: [
          {
            path: "prime_checker.py",
            exists: true,
            absolutePath: "/private/workspaces/task-123/prime_checker.py",
          },
        ],
        testResults: [
          { command: "python3 prime_checker.py", exitCode: 0, summary: "ok" },
        ],
        screenshotPaths: [],
        acceptanceCriteriaStatus: [
          { criterion: "prints primes", met: true, evidence: "exact output" },
        ],
        residualRisks: [],
      }),
      "```",
    ].join("\n");

    const out = sanitizeCompletionRelay(input);
    expect(out).toBe("The script now prints the prime numbers through 31.");
    expect(out).not.toContain("realWorkdir");
    expect(out).not.toContain("/private/workspaces");
  });

  it("preserves ordinary fenced JSON that is not a CompletionEnvelope", () => {
    const input = 'Here is the requested data:\n```json\n{"answer":42}\n```';
    expect(sanitizeCompletionRelay(input)).toBe(input);
  });

  it("strips envelopes then truncates the oversized remnant, keeping the head", () => {
    const remnant = "z".repeat(DEFAULT_MAX_RELAY_CHARS + 100);
    const input = `${remnant}\n[tool output: t]\nbody\n[/tool output]`;
    const out = sanitizeCompletionRelay(input);
    expect(out.startsWith("zzz")).toBe(true);
    expect(out).toContain(`${remnant.length} chars total]`);
    expect(out).not.toContain("[tool output:");
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_RELAY_CHARS);
  });

  it("does NOT reduce a long pure-prose deliverable to a bare marker (#11605 regression)", () => {
    // The confirmed failure: a 2.4KB detailed-migration-plan answer (strip is
    // a no-op — no envelopes) synthesized as literally the elision marker.
    const prose = "Here is the detailed migration plan you asked for. ".repeat(
      48,
    ); // ~2.4KB
    const out = sanitizeCompletionRelay(prose);
    expect(out).not.toBe(`[output elided — ${prose.length} chars]`);
    expect(
      out.startsWith("Here is the detailed migration plan you asked for."),
    ).toBe(true);
  });

  it("returns empty when the whole payload was tool output", () => {
    const input = "[tool output: t]\nonly a tool dump\n[/tool output]";
    expect(sanitizeCompletionRelay(input)).toBe("");
  });

  it("returns empty for nullish input", () => {
    expect(sanitizeCompletionRelay(undefined)).toBe("");
    expect(sanitizeCompletionRelay(null)).toBe("");
  });
});

describe("stripEnvelopeSummaryLines", () => {
  it("strips summarizeEnvelope machine lines from a chat relay (live incident shape)", () => {
    const relayed = [
      "starfall is live.",
      "",
      "link: https://nubilio.org/apps/starfall/",
      "workdir: /home/milady/.eliza/workspaces/task-241a6410",
      "diff: 12 files changed",
      "files: 12",
      "tests: bun run test → exit 0",
      "criteria: 3/3 met",
    ].join("\n");
    const out = sanitizeCompletionRelay(relayed);
    expect(out).toContain("starfall is live.");
    expect(out).toContain("link: https://nubilio.org/apps/starfall/");
    expect(out).not.toContain("workdir:");
    expect(out).not.toContain("diff:");
    expect(out).not.toContain("criteria:");
  });

  it("leaves builder prose mentioning tests untouched", () => {
    const prose = "All tests pass now; the tests: they were flaky before.";
    expect(sanitizeCompletionRelay(prose)).toBe(prose);
  });
});

describe("stripStructuredProofLines", () => {
  it("strips APP_CREATE_DONE proof lines and surfaces liveUrl as prose", () => {
    const relayed = [
      "App verification passed.",
      "",
      'APP_CREATE_DONE {"appName":"ocean-wave-loop","files":["src/index.tsx"],"tests":{"passed":2,"failed":0},"liveUrl":"https://nubilio.org/apps/ocean-wave-loop/"}',
    ].join("\n");
    const out = sanitizeCompletionRelay(relayed);
    expect(out).not.toContain("APP_CREATE_DONE");
    expect(out).toContain("Live at https://nubilio.org/apps/ocean-wave-loop/");
  });

  it("does not duplicate a URL already stated in prose", () => {
    const relayed = [
      "The app is live at https://nubilio.org/apps/foo/",
      'APP_CREATE_DONE {"appName":"foo","liveUrl":"https://nubilio.org/apps/foo/"}',
    ].join("\n");
    const out = sanitizeCompletionRelay(relayed);
    expect(out.match(/nubilio\.org\/apps\/foo/g)).toHaveLength(1);
    expect(out).not.toContain("APP_CREATE_DONE");
  });
});
