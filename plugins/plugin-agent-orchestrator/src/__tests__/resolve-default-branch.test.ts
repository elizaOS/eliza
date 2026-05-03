/**
 * Tests for `resolveDefaultBranch` — the helper that asks `git ls-remote
 * --symref <repo> HEAD` what the default branch is so the orchestrator
 * stops hardcoding "main" and failing to clone repos whose default is
 * "alpha" / "develop" / "master".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: ReadonlyArray<string>,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, "", "");
    },
  ),
);

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

const { resolveDefaultBranch, _clearDefaultBranchCache } = await import(
  "../services/workspace-service"
);

describe("resolveDefaultBranch", () => {
  beforeEach(() => {
    _clearDefaultBranchCache();
    mockExecFile.mockClear();
  });

  it("parses the symref response and returns the default branch", async () => {
    mockExecFile.mockImplementationOnce((_file, _args, _opts, cb) => {
      cb(
        null,
        "ref: refs/heads/alpha\tHEAD\n0000000000000000000000000000000000000000\tHEAD\n",
        "",
      );
    });
    expect(
      await resolveDefaultBranch(
        "https://github.com/elizaos-plugins/plugin-discord.git",
      ),
    ).toBe("alpha");
  });

  it("handles repos that default to main", async () => {
    mockExecFile.mockImplementationOnce((_file, _args, _opts, cb) => {
      cb(
        null,
        "ref: refs/heads/main\tHEAD\n0000000000000000000000000000000000000000\tHEAD\n",
        "",
      );
    });
    expect(
      await resolveDefaultBranch("https://github.com/elizaOS/eliza.git"),
    ).toBe("main");
  });

  it("falls back to main when ls-remote fails (network error, private repo, etc.)", async () => {
    mockExecFile.mockImplementationOnce((_file, _args, _opts, cb) => {
      cb(new Error("fatal: could not read Username for ..."), "", "");
    });
    expect(await resolveDefaultBranch("https://example.invalid/repo.git")).toBe(
      "main",
    );
  });

  it("falls back to main when the response is unexpected", async () => {
    mockExecFile.mockImplementationOnce((_file, _args, _opts, cb) => {
      cb(null, "garbage output with no symref line\n", "");
    });
    expect(await resolveDefaultBranch("https://example.com/repo.git")).toBe(
      "main",
    );
  });

  it("caches the result so repeated calls for the same repo skip ls-remote", async () => {
    mockExecFile.mockImplementationOnce((_file, _args, _opts, cb) => {
      cb(null, "ref: refs/heads/develop\tHEAD\n", "");
    });
    const url = "https://github.com/elizaos-plugins/plugin-edge-tts.git";
    expect(await resolveDefaultBranch(url)).toBe("develop");
    expect(await resolveDefaultBranch(url)).toBe("develop");
    expect(await resolveDefaultBranch(url)).toBe("develop");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls for the same repo into a single ls-remote", async () => {
    mockExecFile.mockImplementationOnce((_file, _args, _opts, cb) => {
      // Defer the callback so concurrent callers all hit the cache slot
      // before the first lookup resolves.
      setTimeout(() => cb(null, "ref: refs/heads/alpha\tHEAD\n", ""), 5);
    });
    const url = "https://github.com/elizaos-plugins/plugin-anthropic.git";
    const results = await Promise.all([
      resolveDefaultBranch(url),
      resolveDefaultBranch(url),
      resolveDefaultBranch(url),
      resolveDefaultBranch(url),
    ]);
    expect(results).toEqual(["alpha", "alpha", "alpha", "alpha"]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures — a retry hits ls-remote again", async () => {
    mockExecFile
      .mockImplementationOnce((_file, _args, _opts, cb) => {
        cb(new Error("transient network failure"), "", "");
      })
      .mockImplementationOnce((_file, _args, _opts, cb) => {
        cb(null, "ref: refs/heads/master\tHEAD\n", "");
      });
    const url = "https://github.com/some/legacy-repo.git";
    expect(await resolveDefaultBranch(url)).toBe("main");
    expect(await resolveDefaultBranch(url)).toBe("master");
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
