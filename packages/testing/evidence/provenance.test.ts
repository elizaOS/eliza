/**
 * Provenance tests against real git repositories in tmp dirs (git init +
 * commit, no mocks) plus pure runner/fingerprint resolution over explicit env
 * records.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceError } from "./errors.ts";
import {
  buildEnvFingerprint,
  collectGitProvenance,
  resolveRunnerKind,
} from "./provenance.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-prov-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(branch: string): string {
  const dir = tmpDir();
  git(dir, "init", "--initial-branch", branch);
  git(dir, "config", "user.email", "evidence-test@example.com");
  git(dir, "config", "user.name", "Evidence Test");
  fs.writeFileSync(path.join(dir, "file.txt"), "content\n");
  git(dir, "add", "file.txt");
  git(dir, "commit", "-m", "initial", "--no-gpg-sign");
  return dir;
}

describe("collectGitProvenance", () => {
  it("collects the real HEAD commit and branch", () => {
    const repo = initRepo("feat/evidence-test");
    const provenance = collectGitProvenance(repo);
    expect(provenance.commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.branch).toBe("feat/evidence-test");
  });

  it("reports branch HEAD when detached, without repair", () => {
    const repo = initRepo("main");
    git(repo, "checkout", "--detach");
    expect(collectGitProvenance(repo).branch).toBe("HEAD");
  });

  it("fails loud outside a git repository", () => {
    const dir = tmpDir();
    try {
      collectGitProvenance(dir);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).code).toBe("GIT_PROVENANCE_UNAVAILABLE");
      expect((error as EvidenceError).cause).toBeDefined();
    }
  });
});

describe("resolveRunnerKind", () => {
  it("honors an explicit valid ELIZA_EVIDENCE_RUNNER", () => {
    expect(resolveRunnerKind({ ELIZA_EVIDENCE_RUNNER: "vast" })).toBe("vast");
    expect(
      resolveRunnerKind({ ELIZA_EVIDENCE_RUNNER: "local", CI: "true" }),
    ).toBe("local");
  });

  it("rejects an invalid explicit runner instead of downgrading", () => {
    expect(() =>
      resolveRunnerKind({ ELIZA_EVIDENCE_RUNNER: "docker" }),
    ).toThrow(EvidenceError);
  });

  it("infers ci from a truthy CI env", () => {
    expect(resolveRunnerKind({ CI: "true" })).toBe("ci");
    expect(resolveRunnerKind({ CI: "1" })).toBe("ci");
  });

  it("defaults to local when CI is unset or falsy", () => {
    expect(resolveRunnerKind({})).toBe("local");
    expect(resolveRunnerKind({ CI: "" })).toBe("local");
    expect(resolveRunnerKind({ CI: "false" })).toBe("local");
    expect(resolveRunnerKind({ CI: "0" })).toBe("local");
  });
});

describe("buildEnvFingerprint", () => {
  const facts = {
    nodeVersion: "v24.1.0",
    bunVersion: "1.3.0",
    platform: "linux",
    arch: "x64",
  };

  it("contains exactly the allowlisted keys and never dumps env", () => {
    const fingerprint = buildEnvFingerprint(
      "gpu",
      { TEST_LANE: "post-merge", SECRET_API_KEY: "leak-me" },
      facts,
    );
    expect(fingerprint).toEqual({
      node: "v24.1.0",
      bun: "1.3.0",
      platform: "linux",
      arch: "x64",
      tier: "gpu",
      testLane: "post-merge",
    });
  });

  it("omits bun and testLane when not applicable", () => {
    const fingerprint = buildEnvFingerprint(
      "cpu",
      {},
      { nodeVersion: "v24.1.0", platform: "darwin", arch: "arm64" },
    );
    expect(fingerprint).toEqual({
      node: "v24.1.0",
      platform: "darwin",
      arch: "arm64",
      tier: "cpu",
    });
  });
});
