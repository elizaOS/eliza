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
  it("isolates credentials while coalescing concurrent reads in one scope", async () => {
    const callbacks: Array<
      (err: Error | null, stdout: string, stderr: string) => void
    > = [];
    execFileMock.mockImplementation((_file, _args, _opts, cb) =>
      callbacks.push(cb),
    );
    const url = "https://github.com/o/private";
    const first = resolveDefaultBranch(url, "test-token-one");
    const duplicate = resolveDefaultBranch(url, "test-token-one");
    const second = resolveDefaultBranch(url, "test-token-two");
    const anonymous = resolveDefaultBranch(url);
    expect(first).toBe(duplicate);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    callbacks[0]?.(null, "ref: refs/heads/one\tHEAD\n", "");
    callbacks[1]?.(null, "ref: refs/heads/two\tHEAD\n", "");
    callbacks[2]?.(null, "ref: refs/heads/public\tHEAD\n", "");
    await expect(
      Promise.all([first, duplicate, second, anonymous]),
    ).resolves.toEqual(["one", "one", "two", "public"]);
    await expect(resolveDefaultBranch(url, "test-token-two")).resolves.toBe(
      "two",
    );
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

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
