/**
 * Drives real local and bare Git repositories to prove explicitly named atomic
 * branch/tag publication: hook rejection changes no refs, remote movement needs
 * a rebase, matching annotated tags no-op after dereference, and conflicting or
 * permanently reserved tags fail.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAndPackReleaseCandidate,
  loadReleaseState,
  recordReleaseTransition,
} from "../lib/release-candidate.mjs";
import {
  assertReleaseTagAllowed,
  pushAtomicReleaseRefs,
} from "../lib/release-git.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function git(repoRoot: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function remoteRefs(repoRoot: string, remote: string) {
  return git(repoRoot, ["ls-remote", remote]);
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeScenario() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-git-"));
  roots.push(base);
  const repoRoot = path.join(base, "source");
  const remote = path.join(base, "remote.git");
  fs.mkdirSync(repoRoot);
  git(repoRoot, ["init", "-b", "develop"]);
  git(repoRoot, ["config", "user.name", "Release Git Test"]);
  git(repoRoot, ["config", "user.email", "release-git@example.test"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "base"]);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  execFileSync("git", ["init", "--bare", remote]);
  git(repoRoot, ["remote", "add", "release-test", remote]);
  git(repoRoot, ["push", "release-test", `${baseSha}:refs/heads/develop`]);

  writeJson(path.join(repoRoot, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  writeJson(path.join(repoRoot, "packages/a/package.json"), {
    name: "@release-git/a",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    files: ["index.js"],
    publishConfig: { access: "public" },
  });
  fs.writeFileSync(
    path.join(repoRoot, "packages/a/index.js"),
    "export default 'a';\n",
  );
  fs.writeFileSync(
    path.join(repoRoot, "build.mjs"),
    "// Candidate is already built.\n",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "release candidate"]);
  const releaseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  const candidateDirectory = path.join(base, "candidate");
  buildAndPackReleaseCandidate({
    repoRoot,
    outputDirectory: candidateDirectory,
    packageNames: ["@release-git/a"],
    version: "1.0.0",
    channel: "beta",
    sourceSha: releaseSha,
    expectedCommit: releaseSha,
    build: { command: process.execPath, args: ["build.mjs"] },
  });
  recordReleaseTransition(candidateDirectory, "registry-bound", {
    registry: "local",
  });
  recordReleaseTransition(candidateDirectory, "registry-staged", {
    registry: "local",
  });
  recordReleaseTransition(candidateDirectory, "registry-verified", {
    registry: "local",
  });
  recordReleaseTransition(candidateDirectory, "channel-promoted", {
    channel: "beta",
  });
  return { base, repoRoot, remote, baseSha, releaseSha, candidateDirectory };
}

describe("atomic release refs", () => {
  test("one rejected ref rejects the entire atomic push and no unrelated tag follows", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, ["tag", "unrelated-local-tag", fixture.releaseSha]);
    const hookPath = path.join(fixture.remote, "hooks/update");
    fs.writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "refs/tags/v1.0.0" ]; then',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(hookPath, 0o755);

    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("git push failed");
    const rejectedRefs = remoteRefs(fixture.repoRoot, fixture.remote);
    expect(rejectedRefs).toContain(`${fixture.baseSha}\trefs/heads/develop`);
    expect(rejectedRefs).not.toContain("refs/tags/v1.0.0");
    expect(rejectedRefs).not.toContain("unrelated-local-tag");
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-bound",
    );

    fs.unlinkSync(hookPath);
    expect(
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toMatchObject({ pushed: true, expectedCommit: fixture.releaseSha });
    const acceptedRefs = remoteRefs(fixture.repoRoot, fixture.remote);
    expect(acceptedRefs).toContain(`${fixture.releaseSha}\trefs/heads/develop`);
    expect(acceptedRefs).toContain(
      `${fixture.releaseSha}\trefs/tags/v1.0.0^{}`,
    );
    expect(acceptedRefs).not.toContain("unrelated-local-tag");
    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.1",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("Conflicting evidence for already-recorded phase git-bound");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/v1.0.1",
    );
  }, 30_000);

  test("a post-push interruption binds retry intent before remote mutation", () => {
    const fixture = makeScenario();
    const lockPath = path.join(
      fixture.candidateDirectory,
      "release-state.json.lock",
    );
    const hookPath = path.join(fixture.remote, "hooks/post-receive");
    fs.writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' post-receive > ${JSON.stringify(lockPath)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(hookPath, 0o755);

    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: "release-test",
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("locked by another writer");
    const interruptedRefs = remoteRefs(fixture.repoRoot, fixture.remote);
    expect(interruptedRefs).toContain(
      `${fixture.releaseSha}\trefs/heads/develop`,
    );
    expect(interruptedRefs).toContain(
      `${fixture.releaseSha}\trefs/tags/v1.0.0^{}`,
    );
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-bound",
    );

    fs.unlinkSync(hookPath);
    fs.unlinkSync(lockPath);
    const changedRemote = path.join(fixture.base, "changed-remote.git");
    execFileSync("git", ["init", "--bare", changedRemote]);
    git(fixture.repoRoot, ["remote", "set-url", "release-test", changedRemote]);
    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: "release-test",
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("already-recorded phase git-bound");
    expect(remoteRefs(fixture.repoRoot, changedRemote)).toBe("");
    git(fixture.repoRoot, [
      "remote",
      "set-url",
      "release-test",
      fixture.remote,
    ]);
    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: "release-test",
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.releaseSha,
      }),
    ).toThrow("already-recorded phase git-bound");
    expect(
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: "release-test",
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toMatchObject({ pushed: false, expectedCommit: fixture.releaseSha });
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-tagged",
    );
  }, 30_000);

  test("remote source movement fails without an implicit rebase", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, ["checkout", "-b", "remote-moved", fixture.baseSha]);
    fs.writeFileSync(path.join(fixture.repoRoot, "REMOTE.md"), "moved\n");
    git(fixture.repoRoot, ["add", "REMOTE.md"]);
    git(fixture.repoRoot, ["commit", "-m", "remote moved"]);
    const movedSha = git(fixture.repoRoot, ["rev-parse", "HEAD"]);
    git(fixture.repoRoot, [
      "push",
      "release-test",
      `${movedSha}:refs/heads/develop`,
    ]);
    git(fixture.repoRoot, ["checkout", "develop"]);
    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("Remote branch refs/heads/develop moved");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/v1.0.0",
    );
  }, 30_000);

  test("matching annotated tag dereferences to the expected commit and no-ops", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, [
      "tag",
      "-a",
      "v1.0.0",
      fixture.releaseSha,
      "-m",
      "release",
    ]);
    git(fixture.repoRoot, [
      "push",
      "release-test",
      `${fixture.releaseSha}:refs/heads/develop`,
      "refs/tags/v1.0.0:refs/tags/v1.0.0",
    ]);
    expect(
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toMatchObject({ pushed: false, expectedCommit: fixture.releaseSha });
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-tagged",
    );
  }, 30_000);

  test("conflicting and reserved tags fail", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, ["tag", "v1.0.0", fixture.baseSha]);
    git(fixture.repoRoot, [
      "push",
      "release-test",
      "refs/tags/v1.0.0:refs/tags/v1.0.0",
    ]);
    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("Remote tag refs/tags/v1.0.0 resolves");
    for (const tag of ["v2.0.3-beta.8", "v2.0.3-beta.9", "v2.0.3-beta.10"]) {
      expect(() => assertReleaseTagAllowed(tag)).toThrow(
        "reserved failed-release residue",
      );
    }
  }, 30_000);
});
