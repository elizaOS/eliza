/**
 * Offline coverage for the MVP evidence matrix. The live command reads GitHub,
 * but the closeout contract is deterministic over issue labels, titles, and
 * Project rows, so agents can refine the checklist without network access.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const matrix = await import(
  new URL("../audit-mvp-evidence-matrix.mjs", import.meta.url).href
);
const readiness = await import(
  new URL("../check-mvp-board-readiness.mjs", import.meta.url).href
);
const scriptPath = new URL("../audit-mvp-evidence-matrix.mjs", import.meta.url)
  .pathname;

function issue(number: number, title: string, labels: string[], body = "") {
  return {
    number,
    title,
    body,
    url: `https://github.com/elizaOS/eliza/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function projectItem(number: number, status = "Needs human review") {
  return {
    content: {
      type: "Issue",
      number,
      repository: "elizaOS/eliza",
      title: `Issue ${number}`,
    },
    status,
  };
}

function evidenceIds(row: { evidence: Array<{ id: string }> }) {
  return row.evidence.map((evidence) => evidence.id);
}

function evidenceById(
  row: { evidence: Array<{ id: string; collectionHints?: string[] }> },
  id: string,
) {
  return row.evidence.find((evidence) => evidence.id === id);
}

describe("MVP evidence matrix", () => {
  test("adds visual, walkthrough, and device proof for device onboarding UI rows", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14358, "[onboarding] Device e2e for iOS sim + Android emu", [
          "mvp",
          "ui",
          "needs-human",
        ]),
      ],
      { items: [projectItem(14358)] },
    );

    expect(report.counts).toEqual({
      activeProjectIssues: 1,
      humanGated: 1,
      agentActionable: 0,
    });
    expect(report.rows[0].projectStatus).toBe("Needs human review");
    expect(evidenceIds(report.rows[0])).toEqual(
      expect.arrayContaining([
        "issue-closeout-summary",
        "logs",
        "domain-artifacts",
        "visual-screenshots-ocr-color",
        "walkthrough-video",
        "device-artifact-bundle",
      ]),
    );
    expect(
      evidenceById(report.rows[0], "visual-screenshots-ocr-color")
        ?.collectionHints,
    ).toContain("bun run --cwd packages/app audit:app:verify");
    expect(
      evidenceById(report.rows[0], "device-artifact-bundle")?.collectionHints,
    ).toContain("bun run --cwd packages/app capture:ios-sim");
  });

  test("adds live model, connector, and security proof for corpus and permissioning rows", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14747, "[corpus] Personal-corpus scenario program", [
          "mvp",
          "testing",
          "connector",
          "memory",
          "security",
          "needs-shaw",
        ]),
      ],
      { items: [projectItem(14747)] },
    );

    expect(evidenceIds(report.rows[0])).toEqual(
      expect.arrayContaining([
        "live-llm-trajectory",
        "connector-dispatch-proof",
        "security-redaction-proof",
      ]),
    );
  });

  test("adds audio evidence for voice rows", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14374, "[voice] Railway Kokoro/Whisper services", [
          "mvp",
          "voice",
          "needs-human",
        ]),
      ],
      { items: [projectItem(14374)] },
    );

    expect(evidenceIds(report.rows[0])).toContain("voice-audio-latency");
    expect(evidenceIds(report.rows[0])).toContain("walkthrough-video");
  });

  test("keeps open non-blocked MVP issues visible as agent-actionable", () => {
    const report = matrix.buildEvidenceMatrix(
      [issue(15000, "[mvp] Missing blocker", ["mvp", "testing"])],
      { items: [projectItem(15000, "In progress")] },
    );

    expect(report.counts.agentActionable).toBe(1);
    expect(
      report.agentActionable.map((row: { number: number }) => row.number),
    ).toEqual([15000]);
  });

  test("ignores project rows from another repository when assigning status", () => {
    const report = matrix.buildEvidenceMatrix(
      [issue(14783, "[scenarios] Pack G1", ["mvp", "needs-shaw"])],
      {
        items: [
          {
            content: {
              type: "Issue",
              number: 14783,
              repository: "elizaOS/other",
            },
            status: "Done",
          },
        ],
      },
    );

    expect(report.rows).toEqual([]);
  });

  test("renders a GitHub-ready markdown checklist for issue evidence", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14358, "[onboarding] Device e2e for iOS sim + Android emu", [
          "mvp",
          "ui",
          "needs-human",
        ]),
      ],
      { items: [projectItem(14358)] },
    );

    const markdown = matrix.formatMarkdown(report);

    expect(markdown).toContain("# LifeOps MVP Evidence Checklist");
    expect(markdown).toContain("| Active Project 15 issues | 1 |");
    expect(markdown).toContain(
      "### #14358 [onboarding] Device e2e for iOS sim + Android emu",
    );
    expect(markdown).toContain("- Project status: Needs human review");
    expect(markdown).toContain("| Project status source | project |");
    expect(markdown).toContain("- Blocker labels: needs-human");
    expect(markdown).toContain(
      "- [ ] **Before/after screenshots with OCR and color heuristics** (`visual-screenshots-ocr-color`)",
    );
    expect(markdown).toContain("  - Collection hints:");
    expect(markdown).toContain(
      "    - `bun run --cwd packages/app audit:app:verify`",
    );
    expect(markdown).toContain(
      "- [ ] **Per-device screenshots, recording, logs, and status JSON** (`device-artifact-bundle`)",
    );
    expect(markdown).toContain(
      "    - `bun run --cwd packages/app capture:android-emu`",
    );
    expect(markdown).toContain(
      "    - Attach the generated DB rows, memories, scheduled tasks, files, or connector artifacts inline in the issue.",
    );
  });

  test("includes an unlabeled Ready project issue", () => {
    const report = matrix.buildEvidenceMatrix(
      [issue(15748, "Readiness audit completeness", ["testing"])],
      { items: [projectItem(15748, "Ready")] },
    );

    expect(report.counts.activeProjectIssues).toBe(1);
    expect(
      report.agentActionable.map((row: { number: number }) => row.number),
    ).toEqual([15748]);
  });

  test("uses the same active issue set as board readiness", () => {
    const issues = [
      issue(15748, "Unlabeled ready work", ["testing"]),
      issue(14754, "Human device proof", ["needs-human"]),
      issue(15000, "Already done", ["mvp"]),
    ];
    const project = {
      items: [
        projectItem(15748, "Ready"),
        projectItem(14754, "Needs human review"),
        projectItem(15000, "Done"),
      ],
    };

    const matrixReport = matrix.buildEvidenceMatrix(issues, project);
    const readinessReport = readiness.auditMvpBoardReadiness(issues, project);

    expect(
      matrixReport.rows.map((row: { number: number }) => row.number),
    ).toEqual(
      readinessReport.rows
        .map((row: { number: number }) => row.number)
        .sort((a, b) => a - b),
    );
  });

  test("normalizes REST issue rows from GitHub without pull request fields", () => {
    expect(
      matrix.normalizeRestIssue({
        number: 14783,
        title: "[scenarios] Pack G1",
        body: "Evidence body",
        html_url: "https://github.com/elizaOS/eliza/issues/14783",
        labels: [{ name: "mvp" }, { name: "needs-shaw" }],
      }),
    ).toEqual({
      number: 14783,
      title: "[scenarios] Pack G1",
      body: "Evidence body",
      url: "https://github.com/elizaOS/eliza/issues/14783",
      labels: [{ name: "mvp" }, { name: "needs-shaw" }],
    });
  });

  test("CLI no-project mode writes markdown without Project GraphQL data", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-evidence-matrix-"));
    const issuesJson = join(dir, "issues.json");
    const output = join(dir, "checklist.md");
    writeFileSync(
      issuesJson,
      JSON.stringify([
        issue(14358, "[onboarding] Device e2e for iOS sim + Android emu", [
          "mvp",
          "ui",
          "needs-human",
        ]),
      ]),
    );

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--issues-json",
        issuesJson,
        "--no-project",
        "--markdown",
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    const markdown = readFileSync(output, "utf8");
    expect(markdown).toContain("| Project status source | omitted |");
    expect(markdown).toContain("- Project status: not loaded (--no-project)");
    expect(markdown).toContain(
      "- [ ] **Before/after screenshots with OCR and color heuristics** (`visual-screenshots-ocr-color`)",
    );
  });
});
