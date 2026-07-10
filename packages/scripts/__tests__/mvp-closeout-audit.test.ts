/**
 * Exercises the atomic MVP snapshot contract offline, including transport
 * failure and analyzer-set divergence that must never look like readiness.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const audit = await import(
  new URL("../run-mvp-closeout-audit.mjs", import.meta.url).href
);
const scriptPath = new URL("../run-mvp-closeout-audit.mjs", import.meta.url)
  .pathname;

function projectItem(
  number: number,
  status: string,
  labels: string[],
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
    title: `Issue ${number}`,
    status,
    labels,
  };
}

function issue(number: number, labels: string[]) {
  return {
    number,
    title: `Issue ${number}`,
    body: "Evidence contract",
    url: `https://github.com/elizaOS/eliza/issues/${number}`,
    labels: labels.map((name) => ({ name })),
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
    title: `Pull request ${number}`,
    status,
    labels: ["mvp"],
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

function untypedItem(number: number, status = "Ready") {
  return {
    content: {
      number,
      repository: "elizaOS/eliza",
      title: `Issue ${number}`,
      url: `https://github.com/elizaOS/eliza/issues/${number}`,
    },
    title: `Issue ${number}`,
    status,
    labels: ["mvp"],
  };
}

function snapshot() {
  return {
    fetchedAt: "2026-07-09T20:00:00.000Z",
    source: "fixture",
    owner: "elizaOS",
    projectNumber: "15",
    repo: "elizaOS/eliza",
    project: {
      items: [
        projectItem(1, "Ready", ["testing"]),
        projectItem(2, "Needs human review", ["mvp", "needs-human"]),
        projectItem(3, "Done", ["mvp"]),
      ],
    },
    openIssues: [issue(1, ["testing"]), issue(2, ["mvp", "needs-human"])],
    closedIssues: [issue(3, ["mvp"])],
  };
}

describe("atomic MVP closeout audit", () => {
  test("uses one snapshot for unlabeled Ready, readiness, and evidence rows", () => {
    const report = audit.buildCloseoutReport(snapshot());

    expect(report.integrityOk).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.board.counts).toMatchObject({
      projectIssues: 3,
      labeledMvpIssues: 2,
      openNotDone: 2,
      humanGated: 1,
      agentActionable: 1,
    });
    expect(report.readiness.agentActionableCount).toBe(1);
    expect(report.parity.readiness).toEqual([1, 2]);
    expect(report.parity.evidence).toEqual([1, 2]);
  });

  test("excludes Project pull-request cards from issue reconciliation", () => {
    const withPullRequest = snapshot();
    withPullRequest.project.items.push(pullRequestItem(14490));

    const report = audit.buildCloseoutReport(withPullRequest);

    expect(report.integrityOk).toBe(true);
    expect(report.snapshot.projectItemCount).toBe(4);
    expect(report.snapshot.projectIssueItemCount).toBe(3);
    expect(report.board.counts.projectIssues).toBe(3);
    expect(report.parity.readiness).toEqual([1, 2]);
    expect(report.parity.evidence).toEqual([1, 2]);
  });

  test("excludes Project draft cards from issue reconciliation", () => {
    const withDraft = snapshot();
    withDraft.project.items.push(draftItem("Loose planning note"));

    const report = audit.buildCloseoutReport(withDraft);

    expect(report.integrityOk).toBe(true);
    expect(report.snapshot.projectItemCount).toBe(4);
    expect(report.snapshot.projectIssueItemCount).toBe(3);
    expect(report.board.counts.projectIssues).toBe(3);
    expect(report.parity.readiness).toEqual([1, 2]);
    expect(report.parity.evidence).toEqual([1, 2]);
  });

  test("rejects snapshots containing an untyped Project card", () => {
    const withUntyped = snapshot();
    withUntyped.project.items.push(untypedItem(99));

    expect(() => audit.buildCloseoutReport(withUntyped)).toThrow(
      "carries no content.type",
    );
  });

  test("reports analyzer issue-set divergence explicitly", () => {
    expect(
      audit.compareIssueNumberSets(
        [{ number: 1 }, { number: 2 }],
        [{ number: 2 }, { number: 3 }],
      ),
    ).toEqual({
      ok: false,
      readiness: [1, 2],
      evidence: [2, 3],
      missingFromEvidence: [1],
      missingFromReadiness: [3],
    });
  });

  test("rejects empty, duplicate, and cross-state snapshots", () => {
    expect(() =>
      audit.validateSnapshot({
        source: "fixture",
        project: { items: [] },
        openIssues: [],
        closedIssues: [],
      }),
    ).toThrow("project.items must be a non-empty array");

    const duplicate = snapshot();
    duplicate.openIssues.push(issue(1, []));
    expect(() => audit.validateSnapshot(duplicate)).toThrow(
      "duplicate issue #1",
    );

    const crossState = snapshot();
    crossState.closedIssues.push(issue(1, []));
    expect(() => audit.validateSnapshot(crossState)).toThrow(
      "issue #1 appears in both open and closed",
    );

    const truncated = snapshot();
    truncated.closedIssues = [];
    expect(() => audit.validateSnapshot(truncated)).toThrow(
      "Project issue #3 is missing from open/closed snapshot rows",
    );
  });

  test("requires explicit snapshot provenance instead of a fixture default", () => {
    const { source: _omitted, ...sourceless } = snapshot();
    expect(() => audit.validateSnapshot(sourceless)).toThrow(
      "snapshot.source must be a non-empty string",
    );
    expect(() => audit.validateSnapshot({ ...snapshot(), source: "" })).toThrow(
      "snapshot.source must be a non-empty string",
    );
  });

  test("scopes project cards to the audited repository", () => {
    // A card from another repo must not hard-fail validation as a phantom
    // missing issue, and must stay out of the board counts.
    const withForeignCard = snapshot();
    withForeignCard.project.items.push(
      projectItem(99, "Ready", ["mvp"], "elizaOS/other-repo"),
    );
    const report = audit.buildCloseoutReport(withForeignCard);
    expect(report.integrityOk).toBe(true);
    expect(report.board.counts.projectIssues).toBe(3);
    expect(report.parity.readiness).toEqual([1, 2]);

    // A same-numbered foreign card must not stand in for an eliza issue whose
    // own card is gone — that divergence has to stay observable.
    const masked = snapshot();
    masked.project.items = masked.project.items.filter(
      (item) => item.content.number !== 1,
    );
    masked.project.items.push(
      projectItem(1, "Ready", ["testing"], "elizaOS/other-repo"),
    );
    expect(() => audit.validateSnapshot(masked)).toThrow(
      "issue #1 is not present in snapshot project.items",
    );
  });

  test("CLI emits one complete fixture report", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-closeout-fixture-"));
    const fixture = join(dir, "snapshot.json");
    writeFileSync(fixture, JSON.stringify(snapshot()));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--snapshot-json", fixture, "--json"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.integrityOk).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.snapshot.source).toBe("fixture");
  });

  test("CLI treats an untyped Project card as a fatal invalid snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-closeout-untyped-"));
    const fixture = join(dir, "snapshot.json");
    const withUntyped = snapshot();
    withUntyped.project.items.push(untypedItem(99));
    writeFileSync(fixture, JSON.stringify(withUntyped));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--snapshot-json", fixture, "--json"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[mvp-closeout-audit]");
    expect(result.stderr).toContain("carries no content.type");
  });

  test("GitHub command failure exits nonzero without a report", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-closeout-gh-failure-"));
    const fakeGh = join(dir, "gh");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env sh\necho 'rate limit exceeded' >&2\nexit 1\n",
    );
    chmodSync(fakeGh, 0o755);

    const result = spawnSync(process.execPath, [scriptPath, "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("rate limit exceeded");
    expect(result.stderr).toContain("[mvp-closeout-audit]");
  });
});
