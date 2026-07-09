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

describe("audit-mvp-project-board", () => {
  test("summarizeMvpBoard separates stale, human-gated, and actionable rows", () => {
    const summary = board.summarizeMvpBoard({
      projectItems,
      openIssues: [{ number: 2 }, { number: 3 }, { number: 4 }],
      closedIssues: [{ number: 1 }],
    });

    expect(summary.counts).toEqual({
      projectIssues: 4,
      mvpIssues: 4,
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

    expect(text).toContain("Closed MVP issues not marked Done");
    expect(text).toContain("Open MVP issues not Done and not human-gated");
    expect(text).toContain("#3 In progress — Agent tractable");
    expect(text).toContain("open-but-Done: 1");
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
});
