// Regression guard for #13896: PR #13732 committed a 13,480-line esbuild
// bundle (task-pipeline.html) plus 2 PNGs inside
// packages/ui/src/components/chat/widgets/__e2e__/output/ — generated
// artifacts that belong in the gitignored output dir (regenerate via
// `test:task-pipeline-e2e` / `test:orchestrator-accounts-e2e`; the committed
// evidence copies live in .github/issue-evidence/13536-pipeline-activity-inline/).
//
// This test fails if:
//  1. the output dir loses its .gitignore coverage (check-ignore stops
//     matching), or
//  2. any generated artifact under the output dir is git-tracked again
//     (e.g. force-added or the ignore entry is bypassed).
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const OUTPUT_DIR = "packages/ui/src/components/chat/widgets/__e2e__/output";

function git(args: string[]): { status: number | null; stdout: string } {
  const res = spawnSync("git", args, { encoding: "utf8" });
  return { status: res.status, stdout: (res.stdout ?? "").trim() };
}

function repoRoot(): string {
  const { status, stdout } = git(["rev-parse", "--show-toplevel"]);
  if (status !== 0 || stdout.length === 0) {
    throw new Error(
      "could not resolve git repo root (is this a git checkout?)",
    );
  }
  return stdout;
}

describe("chat widgets __e2e__/output hygiene (#13896)", () => {
  it("gitignores the task-pipeline e2e output dir", () => {
    const root = repoRoot();
    // check-ignore exits 0 when the path IS ignored. Probe with a
    // representative generated filename (the dir itself may not exist on a
    // clean checkout since it is fully generated).
    const probe = `${OUTPUT_DIR}/task-pipeline.html`;
    const { status } = spawnSync(
      "git",
      ["-C", root, "check-ignore", "-q", probe],
      {
        encoding: "utf8",
      },
    );
    expect(
      status,
      `${probe} must be gitignored — restore the "${OUTPUT_DIR}/" entry in the root .gitignore`,
    ).toBe(0);
  });

  it("has no git-tracked generated artifacts under the output dir", () => {
    const root = repoRoot();
    const { status, stdout } = spawnSync(
      "git",
      ["-C", root, "ls-files", "--", OUTPUT_DIR],
      { encoding: "utf8" },
    );
    expect(status).toBe(0);
    const tracked = (stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(
      tracked,
      `generated e2e artifacts are committed under ${OUTPUT_DIR} — delete them ` +
        "(regenerate via test:task-pipeline-e2e; evidence copies belong in " +
        ".github/issue-evidence/13536-pipeline-activity-inline/)",
    ).toEqual([]);
  });
});
