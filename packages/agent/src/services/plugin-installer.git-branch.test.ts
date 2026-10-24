/**
 * Regression coverage for `resolveGitBranch`: a remote that cannot be queried is
 * not a branch that does not exist.
 *
 * `git ls-remote --heads <url> <branch>` exits 0 with empty stdout when the
 * branch is absent (the legitimate "no" answer) and exits non-zero when the
 * remote is unreachable. The old code caught every failure and returned
 * `false`, so a DNS blip / TLS failure / missing git on the first candidate
 * silently fell through to `main` and installed a branch the registry never
 * pinned.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock, gitHandler } = vi.hoisted(() => {
  const state: {
    handler: (args: string[]) => {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
  } = {
    handler: () => ({ stdout: "" }),
  };
  const failed = (spec: { stdout?: string; stderr?: string }) =>
    Object.assign(new Error("Command failed: git ls-remote"), {
      code: 128,
      stdout: spec.stdout ?? "",
      stderr: spec.stderr ?? "",
    });
  const execFileMock: { [key: symbol]: unknown } = vi.fn() as never;
  const promisified = (_file: string, args: string[]) => {
    const spec = state.handler(args);
    return spec.code
      ? Promise.reject(failed(spec))
      : Promise.resolve({
          stdout: spec.stdout ?? "",
          stderr: spec.stderr ?? "",
        });
  };
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = promisified;
  return { execFileMock, gitHandler: state };
});

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
// Keep this a unit test of the branch probe: the installer's config/host
// imports resolve to workspace packages whose build output is not needed here.
vi.mock("../config/config.js", () => ({
  loadElizaConfig: vi.fn(),
  saveElizaConfig: vi.fn(),
}));
vi.mock("./registry-client.js", () => ({ getPluginInfo: vi.fn() }));
vi.mock("@elizaos/host/protocol", () => ({ requestRestart: vi.fn() }));

import { resolveGitBranch } from "./plugin-installer.js";
import type { RegistryPluginInfo } from "./registry-client-types.js";

const UNREACHABLE = {
  code: 128,
  stderr:
    "fatal: unable to access 'https://github.com/elizaOS/plugin-x.git/': Could not resolve host: github.com",
};

function plugin(
  git: { v2Branch?: string | null; v1Branch?: string | null } = {},
): RegistryPluginInfo {
  return {
    name: "plugin-x",
    gitRepo: "elizaOS/plugin-x",
    gitUrl: "https://github.com/elizaOS/plugin-x.git",
    description: "Fixture plugin",
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: "@elizaos/plugin-x",
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
    git: {
      v0Branch: null,
      v1Branch: git.v1Branch ?? null,
      v2Branch: git.v2Branch ?? null,
    },
    supports: { v0: false, v1: false, v2: true },
  };
}

/** Answer every ls-remote probe with the same outcome. */
function answerAll(spec: { stdout?: string; stderr?: string; code?: number }) {
  gitHandler.handler = () => spec;
}

afterEach(() => {
  answerAll({ stdout: "" });
});

describe("resolveGitBranch against a flaky remote", () => {
  it("throws when the remote cannot be queried instead of installing an unpinned branch", async () => {
    // The registry pins `next`; every probe fails at the transport level, so
    // nothing is known about which branches exist.
    answerAll(UNREACHABLE);

    await expect(
      resolveGitBranch(plugin({ v2Branch: "next" })),
    ).rejects.toThrow(/could not query the remote/);
  });

  it("still answers `main` when git reports that no candidate ref exists", async () => {
    // `git ls-remote` exit 0 + empty stdout is a real "no such branch".
    answerAll({ stdout: "" });

    await expect(resolveGitBranch(plugin({ v2Branch: "next" }))).resolves.toBe(
      "main",
    );
  });

  it("still uses the pinned branch when the remote confirms it", async () => {
    answerAll({
      stdout: "0123456789abcdef0123456789abcdef01234567\trefs/heads/next\n",
    });

    await expect(resolveGitBranch(plugin({ v2Branch: "next" }))).resolves.toBe(
      "next",
    );
  });
});
