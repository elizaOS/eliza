/**
 * Offline coverage for the MVP board-readiness audit. The live CLI path talks
 * to GitHub, but the policy is deterministic over captured issue and project
 * rows, so regressions should be caught without network access.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const board = await import(
  new URL("../check-mvp-board-readiness.mjs", import.meta.url).href
);
const scriptPath = new URL("../check-mvp-board-readiness.mjs", import.meta.url)
  .pathname;

function issue(number: number, labels: string[]) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/elizaOS/eliza/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function projectItem(
  number: number,
  status: string,
  repository = "elizaOS/eliza",
) {
  return {
    content: {
      type: "Issue",
      number,
      repository,
      title: `Issue ${number}`,
      url: `https://github.com/${repository}/issues/${number}`,
    },
    status,
  };
}

function pullRequestItem(number: number, status = "Done") {
  return {
    content: {
      type: "PullRequest",
      number,
      repository: "elizaOS/eliza",
      title: `Pull request ${number}`,
      url: `https://github.com/elizaOS/eliza/pull/${number}`,
    },
    status,
  };
}

// Real DraftIssue cards from `gh project item-list` carry only type, title,
// and body — no number, repository, or url.
function draftItem(title: string, status = "Todo") {
  return {
    content: { type: "DraftIssue", title, body: "Draft note" },
    title,
    status,
  };
}

describe("MVP board readiness audit", () => {
  test("passes when every open MVP issue has a blocker and human-review status", () => {
    const report = board.auditMvpBoardReadiness(
      [
        issue(14335, ["mvp", "needs-human"]),
        issue(14783, ["mvp", "needs-shaw"]),
      ],
      {
        items: [
          projectItem(14335, "Needs human review"),
          projectItem(14783, "Needs human review"),
        ],
      },
    );

    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(2);
    expect(report.blockerCount).toBe(2);
    expect(report.violations).toEqual([]);
  });

  test("fails and classifies Ready issues without blocker labels as actionable", () => {
    const report = board.auditMvpBoardReadiness([issue(14749, ["mvp"])], {
      items: [projectItem(14749, "Ready")],
    });

    expect(report.ok).toBe(false);
    expect(report.agentActionableCount).toBe(1);
    expect(report.violations).toContainEqual(
      expect.objectContaining({ type: "agent-actionable", number: 14749 }),
    );
    expect(report.rows).toEqual([
      expect.objectContaining({
        number: 14749,
        projectStatus: "Ready",
        blockerLabels: [],
      }),
    ]);
  });

  test("flags blocker-labeled issues outside Needs human review", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14358, ["mvp", "needs-human"])],
      { items: [projectItem(14358, "In progress")] },
    );

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        type: "blocked-status-mismatch",
        number: 14358,
        projectStatus: "In progress",
      }),
    );
  });

  test("ignores repository issues outside the project", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14351, ["mvp", "needs-shaw"])],
      { items: [] },
    );

    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(0);
    expect(report.rows).toEqual([]);
  });

  test("issues-only mode skips project violations but keeps blocker violations", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14351, ["mvp", "needs-shaw"]), issue(14749, ["mvp"])],
      { items: [] },
      { projectCheckSkipped: true },
    );

    expect(report.ok).toBe(false);
    expect(report.projectCheckSkipped).toBe(true);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: "missing-blocker-label",
        number: 14749,
      }),
    ]);
    expect(
      report.violations.some(
        (violation: { type: string }) =>
          violation.type === "missing-project-item",
      ),
    ).toBe(false);
  });

  test("issues-only mode passes when all open MVP issues have blockers", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14351, ["mvp", "needs-shaw"])],
      { items: [] },
      { projectCheckSkipped: true },
    );

    expect(report.ok).toBe(true);
    expect(report.projectCheckSkipped).toBe(true);
    expect(report.rows[0].projectCheckSkipped).toBe(true);
  });

  test("minimum issue guard prevents vacuous fallback passes", () => {
    const report = board.auditMvpBoardReadiness(
      [],
      { items: [] },
      {
        projectCheckSkipped: true,
        minIssues: 1,
      },
    );

    expect(report.ok).toBe(false);
    expect(report.minIssues).toBe(1);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: "too-few-issues",
        minimum: 1,
        actual: 0,
      }),
    ]);
  });

  test("does not scope project items from a different repository by number", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14747, ["mvp", "needs-shaw"])],
      {
        items: [projectItem(14747, "Needs human review", "elizaOS/other-repo")],
      },
    );

    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(0);
  });

  test("does not treat pull-request cards as project issues", () => {
    const report = board.auditMvpBoardReadiness([issue(14490, ["mvp"])], {
      items: [pullRequestItem(14490)],
    });

    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(0);
    expect(report.rows).toEqual([]);
  });

  test("does not treat draft cards as project issues", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14335, ["mvp", "needs-human"])],
      {
        items: [
          projectItem(14335, "Needs human review"),
          draftItem("Loose planning note"),
        ],
      },
    );

    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(1);
    expect(report.rows).toEqual([expect.objectContaining({ number: 14335 })]);
  });

  test("rejects project cards without a content type", () => {
    expect(() =>
      board.auditMvpBoardReadiness([issue(14335, ["mvp", "needs-human"])], {
        items: [
          {
            content: {
              number: 14335,
              repository: "elizaOS/eliza",
              title: "Issue 14335",
              url: "https://github.com/elizaOS/eliza/issues/14335",
            },
            status: "Needs human review",
          },
        ],
      }),
    ).toThrow("carries no content.type");
  });

  test("rejects blank and unknown project card types", () => {
    expect(() =>
      board.projectItemIsIssue({
        content: { type: "   ", title: "Blank type" },
      }),
    ).toThrow("carries no content.type");
    expect(() =>
      board.projectItemIsIssue({
        content: { type: "Discussion", title: "Future card" },
      }),
    ).toThrow('unsupported content.type "Discussion"');
  });

  test("flags human-review status without a blocker label", () => {
    const report = board.auditMvpBoardReadiness([issue(15748, ["testing"])], {
      items: [projectItem(15748, "Needs human review")],
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        type: "human-status-missing-blocker",
        number: 15748,
      }),
    );
  });

  test("normalizes REST issue rows for the live issue inventory", () => {
    expect(
      board.normalizeRestIssue({
        number: 14351,
        title: "Verify shift rotation",
        html_url: "https://github.com/elizaOS/eliza/issues/14351",
        labels: [{ name: "mvp" }, { name: "needs-shaw" }],
      }),
    ).toEqual({
      number: 14351,
      title: "Verify shift rotation",
      url: "https://github.com/elizaOS/eliza/issues/14351",
      labels: [{ name: "mvp" }, { name: "needs-shaw" }],
    });
  });

  test("CLI issues-only fixture mode reports skipped Project checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-readiness-"));
    const issuesJson = join(dir, "issues.json");
    writeFileSync(
      issuesJson,
      JSON.stringify([issue(14351, ["mvp", "needs-shaw"])]),
    );

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--issues-json", issuesJson, "--issues-only", "--json"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.projectCheckSkipped).toBe(true);
    expect(report.rows[0].projectCheckSkipped).toBe(true);
  });

  test("CLI issues-only fixture mode still fails missing blocker labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-readiness-"));
    const issuesJson = join(dir, "issues.json");
    writeFileSync(issuesJson, JSON.stringify([issue(14749, ["mvp"])]));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--issues-json", issuesJson, "--issues-only", "--json"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.projectCheckSkipped).toBe(true);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: "missing-blocker-label",
        number: 14749,
      }),
    ]);
  });

  test("CLI issues-only fixture mode fails when below minimum issue count", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-readiness-"));
    const issuesJson = join(dir, "issues.json");
    writeFileSync(issuesJson, JSON.stringify([]));

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--issues-json",
        issuesJson,
        "--issues-only",
        "--min-issues",
        "1",
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: "too-few-issues",
        minimum: 1,
        actual: 0,
      }),
    ]);
  });

  test("CLI fixture mode fails fast on a project card without a content type", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-readiness-untyped-"));
    const issuesJson = join(dir, "issues.json");
    const projectJson = join(dir, "project.json");
    writeFileSync(
      issuesJson,
      JSON.stringify([issue(14335, ["mvp", "needs-human"])]),
    );
    writeFileSync(
      projectJson,
      JSON.stringify({
        items: [
          {
            content: {
              number: 14335,
              repository: "elizaOS/eliza",
              title: "Issue 14335",
            },
            status: "Needs human review",
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--issues-json",
        issuesJson,
        "--project-json",
        projectJson,
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("carries no content.type");
  });

  test("CLI help documents issue-only fixture mode", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "--issues-json issues.json --issues-only [--json]",
    );
    expect(result.stdout).toContain(
      "Skip Project status lookup and check only open MVP blocker labels.",
    );
    expect(result.stdout).toContain(
      "--min-issues n  Fail if fewer than n open MVP issues are loaded.",
    );
  });

  test("CLI rejects invalid minimum issue counts", () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--issues-only", "--min-issues", "one"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "check-mvp-board-readiness: --min-issues must be a non-negative integer",
    );
  });
});
