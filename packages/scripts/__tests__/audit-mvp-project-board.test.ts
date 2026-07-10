/**
 * Fixture coverage for the LifeOps MVP project-board audit. Live GitHub state
 * belongs to the CLI; these tests pin the stale-card buckets agents use during
 * closeout review.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const board = await import(
  new URL("../audit-mvp-project-board.mjs", import.meta.url).href
);
const scriptPath = new URL("../audit-mvp-project-board.mjs", import.meta.url)
  .pathname;

const projectItems = [
  {
    content: {
      type: "Issue",
      number: 1,
      title: "Closed implementation",
      url: "https://github.com/elizaOS/eliza/issues/1",
    },
    title: "Closed implementation",
    status: "In progress",
    labels: ["mvp", "testing"],
  },
  {
    content: {
      type: "Issue",
      number: 2,
      title: "Needs device evidence",
      url: "https://github.com/elizaOS/eliza/issues/2",
    },
    title: "Needs device evidence",
    status: "Needs human review",
    labels: ["mvp", "needs-human"],
  },
  {
    content: {
      type: "Issue",
      number: 3,
      title: "Agent tractable",
      url: "https://github.com/elizaOS/eliza/issues/3",
    },
    title: "Agent tractable",
    status: "In progress",
    labels: ["mvp", "testing"],
  },
  {
    content: {
      type: "Issue",
      number: 4,
      title: "Open but done",
      url: "https://github.com/elizaOS/eliza/issues/4",
    },
    title: "Open but done",
    status: "Done",
    labels: ["mvp"],
  },
  {
    content: {
      type: "PullRequest",
      number: 5,
      title: "Ignored PR",
      url: "https://github.com/elizaOS/eliza/pull/5",
    },
    title: "Ignored PR",
    status: "In progress",
    labels: ["mvp"],
  },
];

const restOpenIssues = [
  {
    number: 10,
    title: "Needs owner device",
    html_url: "https://github.com/elizaOS/eliza/issues/10",
    labels: [{ name: "mvp" }, { name: "needs-human" }],
  },
  {
    number: 11,
    title: "Ready for agent",
    html_url: "https://github.com/elizaOS/eliza/issues/11",
    labels: [{ name: "mvp" }, { name: "testing" }],
  },
  {
    number: 12,
    title: "Different lane",
    html_url: "https://github.com/elizaOS/eliza/issues/12",
    labels: [{ name: "testing" }],
  },
];

const restClosedIssues = [
  {
    number: 13,
    title: "Closed MVP row",
    html_url: "https://github.com/elizaOS/eliza/issues/13",
    labels: ["mvp"],
  },
];

describe("audit-mvp-project-board", () => {
  test("summarizeMvpBoard separates stale, human-gated, and actionable rows", () => {
    const summary = board.summarizeMvpBoard({
      projectItems,
      openIssues: [{ number: 2 }, { number: 3 }, { number: 4 }],
      closedIssues: [{ number: 1 }],
    });

    expect(summary.counts).toEqual({
      projectIssues: 4,
      labeledMvpIssues: 4,
      closedNotDone: 1,
      openNotDone: 2,
      humanGated: 1,
      agentActionable: 1,
      openDone: 1,
    });
    expect(summary.closedNotDone.map((issue) => issue.number)).toEqual([1]);
    expect(summary.humanGated.map((issue) => issue.number)).toEqual([2]);
    expect(summary.agentActionable.map((issue) => issue.number)).toEqual([3]);
    expect(summary.openDone.map((issue) => issue.number)).toEqual([4]);
  });

  test("formatSummary includes each actionable section", () => {
    const text = board.formatSummary(
      board.summarizeMvpBoard({
        projectItems,
        openIssues: [{ number: 2 }, { number: 3 }, { number: 4 }],
        closedIssues: [{ number: 1 }],
      }),
    );

    expect(text).toContain("Closed Project 15 issues not marked Done");
    expect(text).toContain(
      "Open Project 15 issues not Done and not human-gated",
    );
    expect(text).toContain("#3 In progress — Agent tractable");
    expect(text).toContain("open-but-Done: 1");
  });

  test("includes an unlabeled Ready project issue in the actionable set", () => {
    const unlabeledReady = {
      content: {
        type: "Issue",
        number: 6,
        title: "Unlabeled ready work",
        url: "https://github.com/elizaOS/eliza/issues/6",
      },
      title: "Unlabeled ready work",
      status: "Ready",
      labels: ["testing"],
    };
    const summary = board.summarizeMvpBoard({
      projectItems: [...projectItems, unlabeledReady],
      openIssues: [{ number: 2 }, { number: 3 }, { number: 4 }, { number: 6 }],
      closedIssues: [{ number: 1 }],
    });

    expect(summary.agentActionable.map((issue) => issue.number)).toContain(6);
    expect(summary.counts.projectIssues).toBe(5);
    expect(summary.counts.labeledMvpIssues).toBe(4);
  });

  test("normalizeProjectIssue excludes non-issue cards and rejects untyped cards", () => {
    expect(
      board.normalizeProjectIssue({
        content: {
          type: "PullRequest",
          number: 7,
          title: "Ignored PR",
          url: "https://github.com/elizaOS/eliza/pull/7",
        },
        status: "Done",
      }),
    ).toBeNull();
    // Real DraftIssue cards carry only type, title, and body.
    expect(
      board.normalizeProjectIssue({
        content: { type: "DraftIssue", title: "Loose planning note" },
        status: "Todo",
      }),
    ).toBeNull();
    expect(() =>
      board.normalizeProjectIssue({
        content: { number: 8, title: "Untyped card" },
        status: "Ready",
      }),
    ).toThrow("carries no content.type");
  });

  test("strictViolations returns the stale buckets that should fail closeout", () => {
    const summary = board.summarizeMvpBoard({
      projectItems,
      openIssues: [{ number: 2 }, { number: 3 }, { number: 4 }],
      closedIssues: [{ number: 1 }],
    });

    expect(board.strictViolations(summary)).toEqual([
      expect.objectContaining({ type: "closed-not-done", count: 1 }),
      expect.objectContaining({ type: "agent-actionable-open", count: 1 }),
      expect.objectContaining({ type: "open-done", count: 1 }),
    ]);
  });

  test("summarizeMvpIssuesOnly reports partial label state without project buckets", () => {
    const summary = board.summarizeMvpIssuesOnly({
      openIssues: restOpenIssues,
      closedIssues: restClosedIssues,
    });

    expect(summary.projectCheckSkipped).toBe(true);
    expect(summary.counts).toEqual({
      openMvpIssues: 2,
      closedMvpIssues: 1,
      humanGated: 1,
      agentActionable: 1,
    });
    expect(summary.humanGated.map((issue) => issue.number)).toEqual([10]);
    expect(summary.agentActionable.map((issue) => issue.number)).toEqual([11]);
    expect(board.strictViolations(summary)).toEqual([
      expect.objectContaining({
        type: "agent-actionable-open",
        message: "1 open MVP issue(s) are not human-gated",
      }),
    ]);
  });

  test("formatSummary makes issues-only Project status omission explicit", () => {
    const text = board.formatSummary(
      board.summarizeMvpIssuesOnly({
        openIssues: restOpenIssues,
        closedIssues: restClosedIssues,
      }),
    );

    expect(text).toContain("Project status check: SKIPPED (--issues-only)");
    expect(text).toContain(
      "open MVP issues: 2 (1 human-gated, 1 agent-actionable)",
    );
    expect(text).toContain("Open MVP issues not human-gated");
    expect(text).toContain("#11 — Ready for agent");
    expect(text).not.toContain("closed-not-Done");
  });

  test("CLI fixture mode exits non-zero in strict mode and prints JSON violations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-audit-"));
    const projectJson = join(dir, "project.json");
    const openJson = join(dir, "open.json");
    const closedJson = join(dir, "closed.json");
    writeFileSync(projectJson, JSON.stringify({ items: projectItems }));
    writeFileSync(
      openJson,
      JSON.stringify([{ number: 2 }, { number: 3 }, { number: 4 }]),
    );
    writeFileSync(closedJson, JSON.stringify([{ number: 1 }]));

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--project-json",
        projectJson,
        "--open-json",
        openJson,
        "--closed-json",
        closedJson,
        "--json",
        "--strict",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("strict failed");
    const parsed = JSON.parse(result.stdout);
    expect(
      parsed.strictViolations.map(
        (violation: { type: string }) => violation.type,
      ),
    ).toEqual(["closed-not-done", "agent-actionable-open", "open-done"]);
  });

  test("CLI fixture mode exits zero in strict mode when only human-gated rows remain", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-audit-clean-"));
    const projectJson = join(dir, "project.json");
    const openJson = join(dir, "open.json");
    const closedJson = join(dir, "closed.json");
    writeFileSync(
      projectJson,
      JSON.stringify({
        items: [
          {
            content: {
              type: "Issue",
              number: 2,
              title: "Needs device evidence",
              url: "https://github.com/elizaOS/eliza/issues/2",
            },
            title: "Needs device evidence",
            status: "Needs human review",
            labels: ["mvp", "needs-human"],
          },
        ],
      }),
    );
    writeFileSync(openJson, JSON.stringify([{ number: 2 }]));
    writeFileSync(closedJson, JSON.stringify([]));

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--project-json",
        projectJson,
        "--open-json",
        openJson,
        "--closed-json",
        closedJson,
        "--json",
        "--strict",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.strictViolations).toEqual([]);
    expect(parsed.counts.humanGated).toBe(1);
  });

  test("CLI issues-only fixture mode skips project data and fails only actionable open MVP issues", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-audit-issues-only-"));
    const openJson = join(dir, "open.json");
    const closedJson = join(dir, "closed.json");
    writeFileSync(openJson, JSON.stringify(restOpenIssues));
    writeFileSync(closedJson, JSON.stringify(restClosedIssues));

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--issues-only",
        "--open-json",
        openJson,
        "--closed-json",
        closedJson,
        "--json",
        "--strict",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("strict failed");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.projectCheckSkipped).toBe(true);
    expect(parsed.strictViolations).toEqual([
      expect.objectContaining({ type: "agent-actionable-open", count: 1 }),
    ]);
    expect(parsed.strictViolations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "closed-not-done" }),
        expect.objectContaining({ type: "open-done" }),
      ]),
    );
  });

  test("CLI issues-only fixture mode exits zero when all open MVP issues are human-gated", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-audit-issues-clean-"));
    const openJson = join(dir, "open.json");
    const closedJson = join(dir, "closed.json");
    writeFileSync(
      openJson,
      JSON.stringify([
        {
          number: 10,
          title: "Needs owner device",
          html_url: "https://github.com/elizaOS/eliza/issues/10",
          labels: [{ name: "mvp" }, { name: "needs-shaw" }],
        },
      ]),
    );
    writeFileSync(closedJson, JSON.stringify(restClosedIssues));

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--issues-only",
        "--open-json",
        openJson,
        "--closed-json",
        closedJson,
        "--json",
        "--strict",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.projectCheckSkipped).toBe(true);
    expect(parsed.strictViolations).toEqual([]);
    expect(parsed.counts.humanGated).toBe(1);
  });
});
