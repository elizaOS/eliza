/**
 * Fixture coverage for the LifeOps MVP project-board audit. Live GitHub state
 * belongs to the CLI; these tests pin the stale-card buckets agents use during
 * closeout review.
 */

import { describe, expect, test } from "bun:test";

const board = await import(
  new URL("../audit-mvp-project-board.mjs", import.meta.url).href
);

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
});
