/**
 * Publishes the explicitly named release branch and tag as one atomic Git push.
 * Remote branch movement, conflicting tags, rejected refs, and reserved failed
 * beta tags are hard failures; a matching annotated or lightweight tag is an
 * idempotent no-op after dereferencing to the planned commit.
 */

import { spawnSync } from "node:child_process";
import {
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "./release-candidate.mjs";
import {
  RELEASE_PHASES,
  releaseTransitionEvidence,
  stableStringify,
  validateCommitSha,
} from "./release-contract.mjs";

const RESERVED_TAGS = new Set([
  "v2.0.3-beta.8",
  "v2.0.3-beta.9",
  "v2.0.3-beta.10",
]);

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`git ${args[0]} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function assertRefName(repoRoot, refName) {
  runGit(repoRoot, ["check-ref-format", refName]);
}

function resolveRemotePushUrls(repoRoot, remote) {
  const result = spawnSync(
    "git",
    ["remote", "get-url", "--push", "--all", remote],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    return [runGit(repoRoot, ["ls-remote", "--get-url", "--", remote])];
  const urls = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length === 0)
    throw new Error(`Git remote ${remote} has no push URL`);
  return urls;
}

export function assertReleaseTagAllowed(tag) {
  if (RESERVED_TAGS.has(tag)) {
    throw new Error(
      `${tag} is reserved failed-release residue and must never be reused or retagged`,
    );
  }
}

function parseLsRemote(output) {
  const refs = new Map();
  if (!output) return refs;
  for (const line of output.split("\n")) {
    const match = line.match(/^([0-9a-f]{40,64})\s+(.+)$/i);
    if (!match) throw new Error(`Malformed git ls-remote output: ${line}`);
    refs.set(match[2], match[1].toLowerCase());
  }
  return refs;
}

function remoteReleaseRefs(repoRoot, remote, branchRef, tagRef) {
  const output = runGit(repoRoot, [
    "ls-remote",
    "--",
    remote,
    branchRef,
    tagRef,
    `${tagRef}^{}`,
  ]);
  const refs = parseLsRemote(output);
  const tagCommit = refs.get(`${tagRef}^{}`) || refs.get(tagRef) || null;
  return { branchCommit: refs.get(branchRef) || null, tagCommit };
}

function assertCommitExists(repoRoot, expectedCommit) {
  const actual = runGit(repoRoot, [
    "rev-parse",
    `${expectedCommit}^{commit}`,
  ]).toLowerCase();
  if (actual !== expectedCommit)
    throw new Error(
      `${expectedCommit} does not resolve to the expected commit`,
    );
}

function localTagCommit(repoRoot, tagRef) {
  const result = spawnSync("git", ["rev-parse", `${tagRef}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim().toLowerCase();
}

function ensureLocalAnnotatedTag(repoRoot, tag, tagRef, expectedCommit) {
  const existingCommit = localTagCommit(repoRoot, tagRef);
  if (existingCommit) {
    if (existingCommit !== expectedCommit) {
      throw new Error(
        `Local tag ${tagRef} resolves to ${existingCommit}, expected ${expectedCommit}`,
      );
    }
    return;
  }
  runGit(repoRoot, [
    "tag",
    "-a",
    "-m",
    `Release ${tag}`,
    "--",
    tag,
    expectedCommit,
  ]);
}

function assertFastForward(repoRoot, oldCommit, expectedCommit) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", oldCommit, expectedCommit],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Remote source moved to ${oldCommit}; ${expectedCommit} is not its descendant. Rebase and create a new candidate`,
    );
  }
}

/**
 * Atomically push only `refs/heads/<branch>` and `refs/tags/<tag>`. A caller
 * must supply the branch SHA it inspected before the candidate was created.
 */
export function pushAtomicReleaseRefs({
  repoRoot,
  candidateDirectory,
  remote,
  branch,
  tag,
  expectedOldBranchSha,
}) {
  if (typeof remote !== "string" || remote.length === 0)
    throw new Error("An explicit Git remote is required");
  assertReleaseTagAllowed(tag);
  const branchRef = `refs/heads/${branch}`;
  const tagRef = `refs/tags/${tag}`;
  assertRefName(repoRoot, branchRef);
  assertRefName(repoRoot, tagRef);
  const expectedOld = validateCommitSha(
    expectedOldBranchSha,
    "expectedOldBranchSha",
  );
  const { plan, state } = verifyReleaseCandidate({
    repoRoot,
    candidateDirectory,
  });
  const expectedCommit = validateCommitSha(
    plan.expectedCommit,
    "expectedCommit",
  );
  assertCommitExists(repoRoot, expectedCommit);
  let phaseIndex = RELEASE_PHASES.indexOf(state.phase);
  const promotedIndex = RELEASE_PHASES.indexOf("channel-promoted");
  const boundIndex = RELEASE_PHASES.indexOf("git-bound");
  const taggedIndex = RELEASE_PHASES.indexOf("git-tagged");
  if (phaseIndex < promotedIndex) {
    throw new Error(
      `Git refs cannot be published from release phase ${state.phase}`,
    );
  }

  const bindingEvidence = {
    remote,
    remotePushUrls: resolveRemotePushUrls(repoRoot, remote),
    branchRef,
    tagRef,
    expectedCommit,
    expectedOldBranchSha: expectedOld,
  };
  if (phaseIndex >= boundIndex) {
    const recorded = releaseTransitionEvidence(state, "git-bound");
    if (stableStringify(recorded) !== stableStringify(bindingEvidence)) {
      throw new Error(
        "Conflicting evidence for already-recorded phase git-bound",
      );
    }
  }
  if (phaseIndex === promotedIndex) {
    recordReleaseTransition(candidateDirectory, "git-bound", bindingEvidence);
    phaseIndex = boundIndex;
  }

  const before = remoteReleaseRefs(repoRoot, remote, branchRef, tagRef);
  if (before.tagCommit && before.tagCommit !== expectedCommit) {
    throw new Error(
      `Remote tag ${tagRef} resolves to ${before.tagCommit}, expected ${expectedCommit}`,
    );
  }
  if (before.branchCommit !== expectedCommit) {
    if (before.branchCommit !== expectedOld) {
      throw new Error(
        `Remote branch ${branchRef} moved from ${expectedOld} to ${before.branchCommit}; rebase before release`,
      );
    }
    assertFastForward(repoRoot, before.branchCommit, expectedCommit);
  }
  if (!before.tagCommit)
    ensureLocalAnnotatedTag(repoRoot, tag, tagRef, expectedCommit);

  const refspecs = [];
  const pushArgs = ["push", "--atomic"];
  if (before.branchCommit !== expectedCommit) {
    pushArgs.push(`--force-with-lease=${branchRef}:${expectedOld}`);
    refspecs.push(`${expectedCommit}:${branchRef}`);
  }
  if (!before.tagCommit) refspecs.push(`${tagRef}:${tagRef}`);
  if (refspecs.length > 0)
    runGit(repoRoot, [...pushArgs, "--", remote, ...refspecs]);

  const after = remoteReleaseRefs(repoRoot, remote, branchRef, tagRef);
  if (
    after.branchCommit !== expectedCommit ||
    after.tagCommit !== expectedCommit
  ) {
    throw new Error(
      `Atomic ref verification failed: branch=${after.branchCommit}, tag=${after.tagCommit}, expected=${expectedCommit}`,
    );
  }
  const completionEvidence = {
    ...bindingEvidence,
    branchCommit: after.branchCommit,
    tagCommit: after.tagCommit,
  };
  if (phaseIndex >= taggedIndex) {
    const recorded = releaseTransitionEvidence(state, "git-tagged");
    if (stableStringify(recorded) !== stableStringify(completionEvidence)) {
      throw new Error(
        "Conflicting evidence for already-recorded phase git-tagged",
      );
    }
  }
  if (phaseIndex === boundIndex) {
    recordReleaseTransition(
      candidateDirectory,
      "git-tagged",
      completionEvidence,
    );
  }
  return { branchRef, tagRef, expectedCommit, pushed: refspecs.length > 0 };
}
