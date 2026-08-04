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
import { Worker } from "node:worker_threads";
import {
  buildAndPackReleaseCandidate,
  loadReleaseState,
  recordReleaseTransition,
} from "../lib/release-candidate.mjs";
import {
  assertReleaseTagAllowed,
  pushAtomicReleaseRefs,
  pushReleaseTag,
  verifyReleaseSource,
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

function preserveGitEvidence(
  fixture: ReturnType<typeof makeScenario>,
  receipt: Record<string, unknown>,
) {
  const evidenceRoot = process.env.RELEASE_EVIDENCE_DIR;
  if (!evidenceRoot) return;
  const target = path.join(evidenceRoot, "git");
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(fixture.candidateDirectory, path.join(target, "candidate"), {
    recursive: true,
    errorOnExist: true,
  });
  writeJson(path.join(target, "git-receipt.json"), receipt);
  fs.writeFileSync(
    path.join(target, "canonical-tag-object.txt"),
    `${git(fixture.repoRoot, ["cat-file", "tag", "refs/tags/v1.0.0"])}\n`,
  );
}

function makeScenario() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-git-"));
  roots.push(base);
  const repoRoot = path.join(base, "source");
  const remotePath = path.join(base, "remote.git");
  const remote = "release-test";
  fs.mkdirSync(repoRoot);
  git(repoRoot, ["init", "-b", "develop"]);
  git(repoRoot, ["config", "user.name", "Release Git Test"]);
  git(repoRoot, ["config", "user.email", "release-git@example.test"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "base"]);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]);
  execFileSync("git", ["init", "--bare", remotePath]);
  const canonicalRemote = "https://github.com/elizaOS/eliza.git";
  git(repoRoot, [
    "config",
    `url.file://${remotePath}.insteadOf`,
    canonicalRemote,
  ]);
  git(repoRoot, ["remote", "add", remote, canonicalRemote]);
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
  const { plan } = buildAndPackReleaseCandidate({
    repoRoot,
    outputDirectory: candidateDirectory,
    packageNames: ["@release-git/a"],
    version: "1.0.0",
    channel: "beta",
    sourceSha: releaseSha,
    expectedCommit: releaseSha,
    repository: "elizaOS/eliza",
    sourceRef: "refs/heads/develop",
    registry: "https://registry.npmjs.org/",
    publisher: "release-git",
    build: { command: "node", args: ["build.mjs"] },
  });
  recordReleaseTransition(candidateDirectory, "registry-bound", {
    registry: plan.registry,
    publisher: plan.publisher,
    candidateTag: plan.candidateTag,
  });
  recordReleaseTransition(candidateDirectory, "registry-staged", {
    registry: plan.registry,
    publisher: plan.publisher,
    candidateTag: plan.candidateTag,
    actions: [],
  });
  recordReleaseTransition(candidateDirectory, "registry-verified", {
    registry: plan.registry,
    packages: [],
  });
  recordReleaseTransition(candidateDirectory, "channel-promoted", {
    registry: plan.registry,
    channel: plan.channel,
    promotions: [],
    candidateTagCleanup: [],
  });
  return {
    base,
    repoRoot,
    remote,
    remotePath,
    canonicalRemote,
    baseSha,
    releaseSha,
    candidateDirectory,
  };
}

describe("atomic release refs", () => {
  test("binds the exact source ref and canonical repository before mutation", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, [
      "push",
      fixture.remote,
      `${fixture.releaseSha}:refs/heads/develop`,
    ]);
    expect(
      verifyReleaseSource({
        repoRoot: fixture.repoRoot,
        remote: fixture.remote,
        repository: "elizaOS/eliza",
        sourceRef: "refs/heads/develop",
        sourceSha: fixture.releaseSha,
      }),
    ).toMatchObject({
      repository: "elizaOS/eliza",
      sourceRef: "refs/heads/develop",
      sourceSha: fixture.releaseSha,
    });
    expect(() =>
      verifyReleaseSource({
        repoRoot: fixture.repoRoot,
        remote: fixture.remote,
        repository: "other/repository",
        sourceRef: "refs/heads/develop",
        sourceSha: fixture.releaseSha,
      }),
    ).toThrow("identifies elizaOS/eliza, expected other/repository");
    expect(() =>
      verifyReleaseSource({
        repoRoot: fixture.repoRoot,
        remote: fixture.remote,
        repository: "elizaOS/eliza",
        sourceRef: "refs/heads/missing",
        sourceSha: fixture.releaseSha,
      }),
    ).toThrow("resolves to null");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/",
    );
  }, 30_000);

  test("one rejected ref rejects the entire atomic push and no unrelated tag follows", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, ["tag", "unrelated-local-tag", fixture.releaseSha]);
    const hookPath = path.join(fixture.remotePath, "hooks/update");
    fs.symlinkSync("/usr/bin/false", hookPath);

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
    ).toThrow("Release tag must be exactly v1.0.0");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/v1.0.1",
    );
  }, 30_000);

  test("tag-only finalization leaves the release branch untouched and retries exactly", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, [
      "push",
      fixture.remote,
      `${fixture.releaseSha}:refs/heads/develop`,
    ]);
    const branchBefore = remoteRefs(fixture.repoRoot, fixture.remote);
    git(fixture.repoRoot, ["tag", "unrelated-local-tag", fixture.releaseSha]);

    const firstPush = pushReleaseTag({
      repoRoot: fixture.repoRoot,
      candidateDirectory: fixture.candidateDirectory,
      remote: fixture.remote,
      tag: "v1.0.0",
    });
    expect(firstPush).toMatchObject({
      pushed: true,
      expectedCommit: fixture.releaseSha,
    });
    const firstRefs = remoteRefs(fixture.repoRoot, fixture.remote);
    expect(firstRefs).toContain(`${fixture.releaseSha}\trefs/heads/develop`);
    expect(firstRefs.match(/refs\/heads\/develop/g)).toEqual(
      branchBefore.match(/refs\/heads\/develop/g),
    );
    expect(firstRefs).toContain(`${fixture.releaseSha}\trefs/tags/v1.0.0^{}`);
    expect(firstRefs).not.toContain("unrelated-local-tag");
    expect(
      git(fixture.repoRoot, [
        "for-each-ref",
        "--format=%(taggername)|%(taggeremail)|%(contents)",
        "refs/tags/v1.0.0",
      ]),
    ).toContain(
      "github-actions[bot]|<41898282+github-actions[bot]@users.noreply.github.com>|Release v1.0.0",
    );
    expect(
      git(fixture.repoRoot, ["cat-file", "tag", "refs/tags/v1.0.0"]),
    ).toContain(`Plan-Integrity: sha512-`);
    expect(git(fixture.repoRoot, ["rev-parse", "refs/tags/v1.0.0"])).toBe(
      firstPush.tagObject,
    );
    expect(
      git(fixture.repoRoot, [
        "for-each-ref",
        "--format=%(taggerdate:raw)",
        "refs/tags/v1.0.0",
      ]),
    ).toBe(
      `${git(fixture.repoRoot, ["show", "-s", "--format=%ct", fixture.releaseSha])} +0000`,
    );

    expect(
      pushReleaseTag({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        tag: "v1.0.0",
      }),
    ).toMatchObject({ pushed: false, expectedCommit: fixture.releaseSha });
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).toBe(firstRefs);
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-tagged",
    );
    preserveGitEvidence(fixture, {
      transport: "ephemeral bare Git repository",
      sourceSha: fixture.releaseSha,
      branchBefore,
      refsAfter: firstRefs,
      canonicalTagObject: firstPush.tagObject,
      tagger: git(fixture.repoRoot, [
        "for-each-ref",
        "--format=%(taggername)|%(taggeremail)|%(taggerdate:raw)",
        "refs/tags/v1.0.0",
      ]),
      tagContents: git(fixture.repoRoot, [
        "cat-file",
        "tag",
        "refs/tags/v1.0.0",
      ]),
      finalState: loadReleaseState(fixture.candidateDirectory),
    });
  }, 30_000);

  test("tag-only rejection and a mismatched planned tag fail without ref mutation", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, [
      "push",
      fixture.remote,
      `${fixture.releaseSha}:refs/heads/develop`,
    ]);
    const hookPath = path.join(fixture.remotePath, "hooks/update");
    fs.symlinkSync("/usr/bin/false", hookPath);
    expect(() =>
      pushReleaseTag({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        tag: "v1.0.0",
      }),
    ).toThrow("git push failed");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/v1.0.0",
    );
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-bound",
    );

    fs.unlinkSync(hookPath);
    expect(() =>
      pushReleaseTag({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        tag: "v1.0.1",
      }),
    ).toThrow("Release tag must be exactly v1.0.0");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/v1.0.1",
    );
  }, 30_000);

  test("a post-push interruption binds retry intent before remote mutation", async () => {
    const fixture = makeScenario();
    const lockPath = path.join(
      fixture.candidateDirectory,
      "release-state.json.lock",
    );
    const ready = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    );
    const worker = new Worker(
      new URL("./fixtures/release-lock-worker.mjs", import.meta.url),
      {
        workerData: {
          lockPath,
          refPath: path.join(fixture.remotePath, "refs/tags/v1.0.0"),
          ready: ready.buffer,
        },
      },
    );
    expect(Atomics.wait(ready, 0, 0, 5_000)).not.toBe("timed-out");
    try {
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
    } finally {
      await worker.terminate();
    }
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

    fs.unlinkSync(lockPath);
    const changedRemote = path.join(fixture.base, "changed-remote.git");
    execFileSync("git", ["init", "--bare", changedRemote]);
    git(fixture.repoRoot, [
      "config",
      "--unset-all",
      `url.file://${fixture.remotePath}.insteadOf`,
    ]);
    git(fixture.repoRoot, [
      "config",
      `url.file://${changedRemote}.insteadOf`,
      fixture.canonicalRemote,
    ]);
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
      "config",
      "--unset-all",
      `url.file://${changedRemote}.insteadOf`,
    ]);
    git(fixture.repoRoot, [
      "config",
      `url.file://${fixture.remotePath}.insteadOf`,
      fixture.canonicalRemote,
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

  test("refuses to publish an ambient lightweight local release tag", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, [
      "push",
      fixture.remote,
      `${fixture.releaseSha}:refs/heads/develop`,
    ]);
    git(fixture.repoRoot, ["tag", "v1.0.0", fixture.releaseSha]);
    expect(() =>
      pushReleaseTag({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        tag: "v1.0.0",
      }),
    ).toThrow("expected canonical object");
    expect(remoteRefs(fixture.repoRoot, fixture.remote)).not.toContain(
      "refs/tags/v1.0.0",
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

  test("same-commit annotated tag with a noncanonical message is a conflict", () => {
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
    expect(() =>
      pushAtomicReleaseRefs({
        repoRoot: fixture.repoRoot,
        candidateDirectory: fixture.candidateDirectory,
        remote: fixture.remote,
        branch: "develop",
        tag: "v1.0.0",
        expectedOldBranchSha: fixture.baseSha,
      }),
    ).toThrow("expected canonical object");
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-bound",
    );
  }, 30_000);

  test("same-commit lightweight remote tag is a conflict", () => {
    const fixture = makeScenario();
    git(fixture.repoRoot, ["tag", "v1.0.0", fixture.releaseSha]);
    git(fixture.repoRoot, [
      "push",
      "release-test",
      `${fixture.releaseSha}:refs/heads/develop`,
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
    ).toThrow("expected canonical object");
    expect(loadReleaseState(fixture.candidateDirectory).state.phase).toBe(
      "git-bound",
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
    ).toThrow("expected canonical object");
    for (const tag of ["v2.0.3-beta.8", "v2.0.3-beta.9", "v2.0.3-beta.10"]) {
      expect(() => assertReleaseTagAllowed(tag)).toThrow(
        "reserved failed-release residue",
      );
    }
  }, 30_000);
});
