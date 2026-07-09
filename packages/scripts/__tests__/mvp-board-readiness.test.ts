/**
 * Offline coverage for the MVP board-readiness audit. The live CLI path talks
 * to GitHub, but the policy is deterministic over captured issue and project
 * rows, so regressions should be caught without network access.
 */

import { describe, expect, test } from "bun:test";

const board = await import(
  new URL("../check-mvp-board-readiness.mjs", import.meta.url).href
);

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
    content: { number, repository, title: `Issue ${number}` },
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

  test("flags open MVP issues without a blocker label", () => {
    const report = board.auditMvpBoardReadiness([issue(14749, ["mvp"])], {
      items: [projectItem(14749, "Ready")],
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        type: "missing-blocker-label",
        number: 14749,
      }),
    );
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

  test("flags open MVP issues missing from the project", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14351, ["mvp", "needs-shaw"])],
      { items: [] },
    );

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        type: "missing-project-item",
        number: 14351,
      }),
    );
  });

  test("does not match project items from a different repository by number", () => {
    const report = board.auditMvpBoardReadiness(
      [issue(14747, ["mvp", "needs-shaw"])],
      {
        items: [projectItem(14747, "Needs human review", "elizaOS/other-repo")],
      },
    );

    expect(report.ok).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        type: "missing-project-item",
        number: 14747,
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
});
