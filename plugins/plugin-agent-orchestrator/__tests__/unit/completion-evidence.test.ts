/**
 * Unit tests for the pure completion-evidence assembler. Pins the sectioning,
 * the mining of build/test lines, the loopback-URL flagging, the artifact
 * references, the size caps, and the thin-completion fallback.
 */

import { describe, expect, it } from "vitest";
import {
  buildCompletionEvidenceString,
  buildEvidenceStringFromInput,
} from "../../src/services/completion-evidence.js";
import type { WorkspaceChangeSet } from "../../src/services/workspace-diff.js";

function changeSet(over: Partial<WorkspaceChangeSet> = {}): WorkspaceChangeSet {
  return {
    changedFiles: ["src/a.ts", "src/b.ts"],
    diffStat: "2 files changed, 10 insertions(+), 2 deletions(-)",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;",
    truncated: false,
    capturedAt: Date.now(),
    ...over,
  };
}

describe("buildEvidenceStringFromInput (legacy signal-mining assembler)", () => {
  it("falls back to the bare summary when no richer signal exists", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "shipped it",
    });
    expect(evidence).toBe("shipped it");
    expect(evidence).not.toContain("##");
  });

  it("renders a CHANGESET section from a real git change set", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "done",
      changeSet: changeSet(),
    });
    expect(evidence).toContain("## CHANGESET");
    expect(evidence).toContain(
      "2 files changed, 10 insertions(+), 2 deletions(-)",
    );
    expect(evidence).toContain("src/a.ts, src/b.ts");
    expect(evidence).toContain("diff --git a/src/a.ts");
  });

  it("omits the CHANGESET section when there are no changed files", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "done",
      changeSet: changeSet({ changedFiles: [], diff: "", diffStat: "" }),
    });
    expect(evidence).not.toContain("## CHANGESET");
  });

  it("renders DELIVERABLE and FINAL REPLY sections", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "I added caching to the search endpoint",
      deliverable: "captured stdout: cache hit ratio 0.94",
    });
    expect(evidence).toContain("## DELIVERABLE");
    expect(evidence).toContain("cache hit ratio 0.94");
    expect(evidence).toContain("## FINAL REPLY");
    expect(evidence).toContain("I added caching to the search endpoint");
  });

  it("flags loopback URLs and keeps public URLs unflagged", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "deployed",
      verifiedUrls: ["http://localhost:3000/app", "https://app.example.com"],
    });
    expect(evidence).toContain("## VERIFIED URLS");
    expect(evidence).toMatch(
      /http:\/\/localhost:3000\/app \(LOOPBACK — not publicly reachable\)/,
    );
    expect(evidence).toContain("https://app.example.com");
    // The public URL line must NOT carry the loopback flag.
    const publicLine = evidence
      .split("\n")
      .find((line) => line.includes("app.example.com"));
    expect(publicLine).not.toMatch(/LOOPBACK/);
  });

  it("mines build/test/typecheck lines out of recorded signals", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "done",
      signals: [
        { text: "just chatting about the weather", source: "message" },
        {
          text: "Running tests...\nTest Files  3 passed (3)\nTests  12 passed (12)",
          source: "message",
        },
        { text: "tsc --noEmit completed with 0 errors", source: "build" },
      ],
    });
    expect(evidence).toContain("## TEST / BUILD / TYPECHECK OUTPUT");
    expect(evidence).toContain("Tests  12 passed (12)");
    expect(evidence).toContain("0 errors");
    // The unrelated chatter line is not mined.
    expect(evidence).not.toContain("weather");
  });

  it("renders an ARTIFACTS section with screenshot/trajectory refs", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "done",
      artifacts: [
        {
          artifactType: "screenshot",
          title: "home page",
          ref: "/tmp/shots/home.png",
        },
        {
          artifactType: "trajectory",
          title: "scenario run",
          ref: "/tmp/traj/run.json",
        },
      ],
    });
    expect(evidence).toContain("## ARTIFACTS");
    expect(evidence).toContain("[screenshot] home page — /tmp/shots/home.png");
    expect(evidence).toContain(
      "[trajectory] scenario run — /tmp/traj/run.json",
    );
  });

  it("assembles all sections in a stable order when everything is present", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "final reply text",
      changeSet: changeSet(),
      deliverable: "deliverable text",
      verifiedUrls: ["https://app.example.com"],
      signals: [{ text: "Tests  1 passed (1)", source: "message" }],
      artifacts: [{ artifactType: "screenshot", title: "shot", ref: "/x.png" }],
    });
    const order = [
      "## CHANGESET",
      "## DELIVERABLE",
      "## FINAL REPLY",
      "## VERIFIED URLS",
      "## TEST / BUILD / TYPECHECK OUTPUT",
      "## ARTIFACTS",
    ].map((header) => evidence.indexOf(header));
    expect(order.every((idx) => idx >= 0)).toBe(true);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });

  it("caps the total assembled evidence size", () => {
    const evidence = buildEvidenceStringFromInput({
      fallbackSummary: "x",
      changeSet: changeSet({ diff: "+line\n".repeat(5000) }),
      deliverable: "d".repeat(50_000),
      finalReply: "r".repeat(50_000),
      verifiedUrls: ["https://a.example.com", "https://b.example.com"],
      signals: Array.from({ length: 60 }, (_, i) => ({
        text: `Tests ${i} passed (1) error warning lint build ${"z".repeat(200)}`,
        source: "message",
      })),
      artifacts: [{ artifactType: "screenshot", title: "s", ref: "/x.png" }],
    });
    expect(evidence.length).toBeLessThanOrEqual(8_100);
    expect(evidence).toContain("[evidence truncated]");
  });
});

describe("buildCompletionEvidenceString (typed bundle, #8894)", () => {
  it("falls back to the bare summary when only the summary is populated", () => {
    const evidence = buildCompletionEvidenceString({
      summary: "shipped it",
      verifiedUrls: [],
      screenshots: [],
    });
    expect(evidence).toBe("shipped it");
    expect(evidence).not.toContain("##");
  });

  it("emits one section per populated field and omits empty ones", () => {
    const evidence = buildCompletionEvidenceString({
      summary: "final reply text",
      diffSummary:
        "diffstat: 1 file changed\nchangedFiles (1): src/a.ts\ndiff:\n+const x = 1;",
      toolOutput: {
        test: "Test Files  3 passed (3)\nTests  12 passed (12)",
        build: "tsc --noEmit completed with 0 errors",
      },
      verifiedUrls: ["https://app.example.com", "http://localhost:3000"],
      screenshots: ["/tmp/shots/home.png"],
      trajectoryPath: "/tmp/traj/run.jsonl",
    });
    expect(evidence).toContain("## CHANGESET");
    expect(evidence).toContain("src/a.ts");
    expect(evidence).toContain("## FINAL REPLY");
    expect(evidence).toContain("final reply text");
    expect(evidence).toContain("## TEST / BUILD / TYPECHECK OUTPUT");
    expect(evidence).toContain("### test");
    expect(evidence).toContain("Tests  12 passed (12)");
    expect(evidence).toContain("### build");
    expect(evidence).toContain("0 errors");
    expect(evidence).toContain("## VERIFIED URLS");
    expect(evidence).toContain("https://app.example.com");
    expect(evidence).toMatch(/http:\/\/localhost:3000 \(LOOPBACK/);
    expect(evidence).toContain("## ARTIFACTS");
    expect(evidence).toContain("[screenshot] screenshot — /tmp/shots/home.png");
    expect(evidence).toContain(
      "[trajectory] completion trajectory — /tmp/traj/run.jsonl",
    );
    // A field that was not populated produces no section.
    expect(evidence).not.toContain("### lint");
  });

  it("omits the tool-output section when every tool field is empty", () => {
    const evidence = buildCompletionEvidenceString({
      summary: "did the work",
      diffSummary: "diffstat: 1 file changed",
      toolOutput: { test: "", build: "  " },
      verifiedUrls: [],
      screenshots: [],
    });
    expect(evidence).not.toContain("## TEST / BUILD / TYPECHECK OUTPUT");
    expect(evidence).toContain("## CHANGESET");
  });
});
