/**
 * Verifies resolveDefaultBranch.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// #9146 — resolveDefaultBranch runs `git ls-remote --symref` to find a repo's
// default branch, with a per-repo cache + a "main" fallback on failure. Mock the
// git dependency (execFile) so the cache + fallback logic is tested w/o network.
const execFileMock = vi.fn();
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const { resolveDefaultBranch, _clearDefaultBranchCache } = await import(
  "../../src/services/workspace-service.js"
);

// Drive the (file, args, opts, cb) execFile callback with a canned git result.
function mockGit(err: Error | null, stdout = "") {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => cb(err, stdout, ""),
  );
}

afterEach(() => {
  _clearDefaultBranchCache();
  execFileMock.mockReset();
});

describe("resolveDefaultBranch", () => {
  it("parses the symref HEAD line into the branch name", async () => {
    mockGit(null, "ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n");
    await expect(resolveDefaultBranch("https://github.com/o/r")).resolves.toBe(
      "develop",
    );
  });

  it("falls back to 'main' on a git failure, and does NOT cache the failure", async () => {
    mockGit(new Error("network down"));
    await expect(
      resolveDefaultBranch("https://github.com/o/down"),
    ).resolves.toBe("main");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // failure isn't cached → a retry hits git again
    await resolveDefaultBranch("https://github.com/o/down");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("caches a successful lookup (one git call for repeated resolves)", async () => {
    mockGit(null, "ref: refs/heads/trunk\tHEAD\n");
    await resolveDefaultBranch("https://github.com/o/cached");
    await resolveDefaultBranch("https://github.com/o/cached");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
