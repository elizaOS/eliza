/**
 * Pins the GIT_MAX_BUFFER contract of the completion-residuals gate: a git
 * probe whose output overflows the spawnSync maxBuffer must degrade to the
 * TYPED `unverifiable` rejection (`git_failed`), never to a clean/dirty
 * verdict computed from clipped output (prompt-integrity REJECT disposition).
 *
 * Harness: mocked `node:child_process` only — spawnSync simulates Node's
 * ENOBUFS overflow shape (killed child, `status: null`, partial stdout,
 * `error` set) for `git status`, while the worktree probe succeeds. The
 * filesystem is real (a temp dir stands in for the workspace).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_cmd: string, args: string[]) => {
    if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
      return { status: 0, stdout: "true\n", stderr: "", signal: null };
    }
    // Node's maxBuffer overflow: child killed, status null, stdout holds
    // only the clipped partial, error carries ENOBUFS.
    return {
      status: null,
      signal: "SIGTERM",
      stdout: "?? clipped-partial-only.ts\n",
      stderr: "",
      error: Object.assign(new Error("spawnSync git ENOBUFS"), {
        code: "ENOBUFS",
      }),
    };
  }),
}));

import { collectCompletionResiduals } from "../services/completion-residuals.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("collectCompletionResiduals — git maxBuffer overflow (mocked spawnSync)", () => {
  it("maps an overflowed git probe to the typed unverifiable rejection, never a verdict from clipped output", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "orch-residuals-enobufs-"));
    roots.push(workdir);
    const result = await collectCompletionResiduals({
      workdir,
      repoExpected: true,
    });
    expect(result.status).toBe("unverifiable");
    expect(result.unverifiableKind).toBe("git_failed");
    // The clipped partial stdout must NOT have been read as a residuals
    // verdict: no uncommitted_changes entry derived from the truncated line.
    expect(
      result.residuals.some((row) => row.kind === "uncommitted_changes"),
    ).toBe(false);
  });
});
