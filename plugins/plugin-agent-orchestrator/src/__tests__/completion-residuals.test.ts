/**
 * Verifies the deterministic completion-residuals gate against REAL temp git
 * repositories (init / dirty tree / unpushed commits vs clean+pushed through a
 * local bare remote) — no mocked git, so the checks prove the actual porcelain
 * and rev-list behavior the gate relies on.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  collectCompletionResiduals,
  MAX_RESIDUAL_PATHS,
  residualDetails,
  residualsCorrection,
  residualsGateEnabled,
  summarizeResiduals,
} from "../services/completion-residuals.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Residuals Test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
}

/** A real working repo with one pushed commit and a local bare upstream. */
function makeRepo(opts: { withUpstream?: boolean } = {}): {
  workdir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "orch-residuals-"));
  roots.push(root);
  const workdir = join(root, "work");
  git(root, "init", "-q", "-b", "main", workdir);
  writeFileSync(join(workdir, "README.md"), "seed\n");
  git(workdir, "add", ".");
  git(workdir, "commit", "-q", "-m", "seed");
  if (opts.withUpstream !== false) {
    const bare = join(root, "origin.git");
    git(root, "init", "-q", "--bare", bare);
    git(workdir, "remote", "add", "origin", bare);
    git(workdir, "push", "-q", "-u", "origin", "main");
  }
  return { workdir };
}

describe("collectCompletionResiduals — real git legs", () => {
  it("passes a clean, fully-pushed workspace", async () => {
    const { workdir } = makeRepo();
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    expect(result.status).toBe("clean");
    expect(result.residuals).toEqual([]);
    expect(result.workdir).toBe(workdir);
    expect(summarizeResiduals(result)).toBe("No completion residuals found.");
  });

  it("flags uncommitted changes (modified + untracked) with porcelain paths", async () => {
    const { workdir } = makeRepo();
    writeFileSync(join(workdir, "README.md"), "modified\n");
    writeFileSync(join(workdir, "untracked.ts"), "export {};\n");
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    expect(result.status).toBe("residuals");
    const residual = result.residuals.find(
      (row) => row.kind === "uncommitted_changes",
    );
    expect(residual?.detail).toContain("2 uncommitted path(s)");
    expect(residual?.items?.join("\n")).toContain("README.md");
    expect(residual?.items?.join("\n")).toContain("untracked.ts");
  });

  it("caps the reported dirty-path list", async () => {
    const { workdir } = makeRepo();
    for (let i = 0; i < MAX_RESIDUAL_PATHS + 5; i += 1) {
      writeFileSync(join(workdir, `file-${i}.txt`), `${i}\n`);
    }
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    const residual = result.residuals.find(
      (row) => row.kind === "uncommitted_changes",
    );
    expect(residual?.detail).toContain(
      `${MAX_RESIDUAL_PATHS + 5} uncommitted path(s)`,
    );
    expect(residual?.items).toHaveLength(MAX_RESIDUAL_PATHS);
  });

  it("flags committed-but-unpushed work against a real bare upstream", async () => {
    const { workdir } = makeRepo();
    writeFileSync(join(workdir, "feature.ts"), "export const x = 1;\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "unpushed feature");
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    expect(result.status).toBe("residuals");
    const residual = result.residuals.find(
      (row) => row.kind === "unpushed_commits",
    );
    expect(residual?.detail).toContain("1 commit(s) not pushed");
    expect(residual?.items).toHaveLength(1);
    // The listed item is the real unpushed sha.
    const head = git(workdir, "rev-parse", "HEAD").trim();
    expect(residual?.items?.[0]).toBe(head);
  });

  it("clears after the unpushed commit is pushed", async () => {
    const { workdir } = makeRepo();
    writeFileSync(join(workdir, "feature.ts"), "export const x = 1;\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "feature");
    git(workdir, "push", "-q", "origin", "main");
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    expect(result.status).toBe("clean");
  });

  it("skips the upstream leg when no upstream is configured", async () => {
    const { workdir } = makeRepo({ withUpstream: false });
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    expect(result.status).toBe("clean");
  });

  it("repo-bound: a missing workdir is unverifiable (never a pass)", async () => {
    const result = await collectCompletionResiduals({
      workdir: join(tmpdir(), "orch-residuals-definitely-missing"),
      repoExpected: true,
    });
    expect(result.status).toBe("unverifiable");
    expect(result.unverifiableReason).toContain("does not exist");
    expect(residualDetails(result)[0]).toContain("workspace unverifiable");
  });

  it("repo-bound: a non-git directory is unverifiable (never a pass)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-residuals-nongit-"));
    roots.push(root);
    const result = await collectCompletionResiduals({
      workdir: root,
      repoExpected: true,
    });
    expect(result.status).toBe("unverifiable");
    expect(result.unverifiableReason).toContain("not a git work tree");
  });
});

describe("collectCompletionResiduals — unbound tasks (repoExpected=false)", () => {
  it("skips the git legs for a non-git scratch dir instead of blocking", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-residuals-scratch-"));
    roots.push(root);
    const result = await collectCompletionResiduals({
      workdir: root,
      repoExpected: false,
    });
    expect(result.status).toBe("clean");
    expect(result.residuals).toEqual([]);
  });

  it("skips the git legs for a missing workdir instead of blocking", async () => {
    const result = await collectCompletionResiduals({
      workdir: join(tmpdir(), "orch-residuals-unbound-missing"),
      repoExpected: false,
    });
    expect(result.status).toBe("clean");
  });

  it("still applies the envelope legs when the git legs are skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-residuals-scratch-env-"));
    roots.push(root);
    const result = await collectCompletionResiduals({
      workdir: root,
      repoExpected: false,
      testResults: [{ command: "bun test", exitCode: 1, summary: "1 failed" }],
    });
    expect(result.status).toBe("residuals");
    expect(result.residuals.map((row) => row.kind)).toEqual([
      "failing_tests_reported",
    ]);
  });

  it("still runs the git legs when the scratch dir IS a real dirty worktree", async () => {
    const { workdir } = makeRepo();
    writeFileSync(join(workdir, "wip.ts"), "// wip\n");
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
    });
    expect(result.status).toBe("residuals");
    expect(result.residuals.map((row) => row.kind)).toContain(
      "uncommitted_changes",
    );
  });

  it("repo-bound dirty worktree is unchanged: residuals", async () => {
    const { workdir } = makeRepo();
    writeFileSync(join(workdir, "wip.ts"), "// wip\n");
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: true,
    });
    expect(result.status).toBe("residuals");
  });
});

describe("collectCompletionResiduals — envelope legs (no workspace)", () => {
  it("skips the git legs entirely when no workdir is supplied and passes on a clean envelope", async () => {
    const result = await collectCompletionResiduals({
      repoExpected: false,
      testResults: [{ command: "bun test", exitCode: 0, summary: "green" }],
      residualRisks: [],
    });
    expect(result.status).toBe("clean");
    expect(result.workdir).toBeUndefined();
  });

  it("flags self-reported failing tests even without a workspace", async () => {
    const result = await collectCompletionResiduals({
      repoExpected: false,
      testResults: [
        { command: "bun test", exitCode: 1, summary: "2 failed" },
        { command: "bun run lint", exitCode: 0, summary: "ok" },
      ],
    });
    expect(result.status).toBe("residuals");
    const residual = result.residuals.find(
      (row) => row.kind === "failing_tests_reported",
    );
    expect(residual?.items).toEqual(["bun test (exit 1)"]);
  });

  it("flags self-reported residual risks even without a workspace", async () => {
    const result = await collectCompletionResiduals({
      repoExpected: false,
      residualRisks: ["migration not run on prod", "  "],
    });
    expect(result.status).toBe("residuals");
    const residual = result.residuals.find(
      (row) => row.kind === "self_reported_risks",
    );
    expect(residual?.items).toEqual(["migration not run on prod"]);
  });

  it("combines envelope residuals with a dirty real workspace", async () => {
    const { workdir } = makeRepo();
    writeFileSync(join(workdir, "wip.ts"), "// wip\n");
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: false,
      testResults: [{ command: "vitest", exitCode: 2, summary: "boom" }],
      residualRisks: ["flaky retry loop"],
    });
    expect(result.status).toBe("residuals");
    expect(result.residuals.map((row) => row.kind).sort()).toEqual([
      "failing_tests_reported",
      "self_reported_risks",
      "uncommitted_changes",
    ]);
    const correction = residualsCorrection(result);
    expect(correction).toContain("NOT done");
    expect(correction).toContain("wip.ts");
    expect(correction).toContain("vitest (exit 2)");
    expect(correction).toContain("flaky retry loop");
  });
});

describe("residualsGateEnabled", () => {
  const prev = process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;
  afterEach(() => {
    if (prev === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;
    else process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = prev;
  });

  it("defaults on", () => {
    delete process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;
    expect(residualsGateEnabled()).toBe(true);
  });

  it("disables only on explicit 0", () => {
    process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = "0";
    expect(residualsGateEnabled()).toBe(false);
    process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = "1";
    expect(residualsGateEnabled()).toBe(true);
  });
});
