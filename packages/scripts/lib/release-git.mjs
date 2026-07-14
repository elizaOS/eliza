/**
 * Publishes explicitly named release refs without wildcard or follow-tag
 * expansion. The transactional workflow uses the tag-only path so source
 * branches are never mutated; the branch/tag primitive remains available for
 * callers that need one atomic fast-forward. Idempotence requires the exact
 * canonical annotated-tag object, not merely a tag that peels to the same
 * commit, so the plan digest and release identity cannot be substituted.
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
  validateGitHubRepository,
  validateSourceRef,
} from "./release-contract.mjs";

const RESERVED_TAGS = new Set([
  "v2.0.3-beta.8",
  "v2.0.3-beta.9",
  "v2.0.3-beta.10",
]);
const RELEASE_TAGGER_NAME = "github-actions[bot]";
const RELEASE_TAGGER_EMAIL =
  "41898282+github-actions[bot]@users.noreply.github.com";

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

function runGitWithInput(repoRoot, args, input) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
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

function repositoryFromRemoteUrl(remoteUrl, remote) {
  let owner;
  let name;
  const scp = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scp) {
    owner = scp[1];
    name = scp[2];
  } else {
    let parsed;
    try {
      parsed = new URL(remoteUrl);
    } catch (error) {
      // error-policy:J2 identify the non-canonical release remote
      throw new Error(`Release remote ${remote} is not a GitHub URL`, {
        cause: error,
      });
    }
    if (
      parsed.hostname.toLowerCase() !== "github.com" ||
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === "https:" && (parsed.username || parsed.password)) ||
      (parsed.protocol === "ssh:" &&
        (parsed.username !== "git" || parsed.password))
    ) {
      throw new Error(`Release remote ${remote} is not a canonical GitHub URL`);
    }
    const pathParts = parsed.pathname.replace(/^\//, "").split("/");
    if (pathParts.length !== 2) {
      throw new Error(`Release remote ${remote} is not a canonical GitHub URL`);
    }
    [owner, name] = pathParts;
  }
  if (name?.endsWith(".git")) name = name.slice(0, -4);
  return validateGitHubRepository(`${owner}/${name}`);
}

function configuredRemoteRepository(repoRoot, remote) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw new Error("Release publication requires a named Git remote");
  }
  const configuredUrls = [
    runGit(repoRoot, ["config", "--get", `remote.${remote}.url`]),
  ];
  const pushUrls = spawnSync(
    "git",
    ["config", "--get-all", `remote.${remote}.pushurl`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (pushUrls.error) throw pushUrls.error;
  if (pushUrls.status !== 0 && pushUrls.status !== 1) {
    throw new Error(`Unable to read push URLs for release remote ${remote}`);
  }
  if (pushUrls.status === 0) {
    configuredUrls.push(
      ...pushUrls.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }
  const repositories = configuredUrls.map((remoteUrl) =>
    repositoryFromRemoteUrl(remoteUrl, remote),
  );
  const [repository] = repositories;
  if (
    repositories.some(
      (candidate) => candidate.toLowerCase() !== repository.toLowerCase(),
    )
  ) {
    throw new Error(`Release remote ${remote} has conflicting repositories`);
  }
  return repository;
}

function assertRemoteRepository(repoRoot, remote, repository) {
  const expected = validateGitHubRepository(repository);
  const actual = configuredRemoteRepository(repoRoot, remote);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Release remote ${remote} identifies ${actual}, expected ${expected}`,
    );
  }
  return actual;
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
  return {
    branchCommit: refs.get(branchRef) || null,
    tagObject: refs.get(tagRef) || null,
    tagCommit: refs.get(`${tagRef}^{}`) || null,
  };
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

function assertTagMatchesPlan(tag, version) {
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(
      `Release tag must be exactly ${expectedTag}, received ${tag}`,
    );
  }
}

function localRefObject(repoRoot, ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim().toLowerCase();
}

function canonicalReleaseTag(
  repoRoot,
  tag,
  expectedCommit,
  plan,
  planIntegrity,
) {
  const taggerTimestamp = runGit(repoRoot, [
    "show",
    "-s",
    "--format=%ct",
    expectedCommit,
  ]);
  if (!/^(0|[1-9]\d*)$/.test(taggerTimestamp)) {
    throw new Error(
      `Release source ${expectedCommit} has invalid commit timestamp ${JSON.stringify(taggerTimestamp)}`,
    );
  }
  const message = [
    `Release ${tag}`,
    "",
    `Repository: ${plan.repository}`,
    `Source-Ref: ${plan.sourceRef}`,
    `Source-SHA: ${expectedCommit}`,
    `Cohort-Integrity: ${plan.cohortIntegrity}`,
    `Plan-Integrity: ${planIntegrity}`,
  ].join("\n");
  const source = [
    `object ${expectedCommit}`,
    "type commit",
    `tag ${tag}`,
    `tagger ${RELEASE_TAGGER_NAME} <${RELEASE_TAGGER_EMAIL}> ${taggerTimestamp} +0000`,
    "",
    message,
    "",
  ].join("\n");
  const objectId = runGitWithInput(
    repoRoot,
    ["hash-object", "-t", "tag", "--stdin"],
    source,
  ).toLowerCase();
  return { objectId, source, taggerTimestamp };
}

function ensureLocalCanonicalTag(repoRoot, tagRef, canonicalTag) {
  const existingObject = localRefObject(repoRoot, tagRef);
  if (existingObject) {
    if (existingObject !== canonicalTag.objectId) {
      throw new Error(
        `Local release tag ${tagRef} is ${existingObject}, expected canonical object ${canonicalTag.objectId}`,
      );
    }
    return existingObject;
  }
  const writtenObject = runGitWithInput(
    repoRoot,
    ["mktag"],
    canonicalTag.source,
  ).toLowerCase();
  if (writtenObject !== canonicalTag.objectId) {
    throw new Error(
      `Canonical tag write produced ${writtenObject}, expected ${canonicalTag.objectId}`,
    );
  }
  runGit(repoRoot, ["update-ref", tagRef, writtenObject]);
  return writtenObject;
}

function assertRemoteCanonicalTag(
  tagRef,
  remoteRefs,
  expectedCommit,
  expectedTagObject,
) {
  if (!remoteRefs.tagObject && !remoteRefs.tagCommit) return false;
  if (
    remoteRefs.tagObject !== expectedTagObject ||
    remoteRefs.tagCommit !== expectedCommit
  ) {
    throw new Error(
      `Remote tag ${tagRef} is object=${remoteRefs.tagObject}, commit=${remoteRefs.tagCommit}; expected canonical object=${expectedTagObject}, commit=${expectedCommit}`,
    );
  }
  return true;
}

/** Prove an exact checked-out source SHA is the tip of its named repository ref. */
export function verifyReleaseSource({
  repoRoot,
  remote,
  repository,
  sourceRef,
  sourceSha,
}) {
  const expectedRepository = validateGitHubRepository(repository);
  const expectedRef = validateSourceRef(sourceRef);
  const expectedCommit = validateCommitSha(sourceSha, "sourceSha");
  assertRemoteRepository(repoRoot, remote, expectedRepository);
  const actualHead = runGit(repoRoot, ["rev-parse", "HEAD"]).toLowerCase();
  if (actualHead !== expectedCommit) {
    throw new Error(
      `Checked-out source is ${actualHead}, expected ${expectedCommit}`,
    );
  }
  const refs = parseLsRemote(
    runGit(repoRoot, ["ls-remote", "--", remote, expectedRef]),
  );
  const actualRefCommit = refs.get(expectedRef) || null;
  if (actualRefCommit !== expectedCommit) {
    throw new Error(
      `Release source ref ${expectedRef} resolves to ${actualRefCommit}, expected ${expectedCommit}`,
    );
  }
  return {
    repository: expectedRepository,
    sourceRef: expectedRef,
    sourceSha: expectedCommit,
    remote,
  };
}

function assertSourceStillReachable(
  repoRoot,
  remote,
  sourceRef,
  expectedCommit,
) {
  const refs = parseLsRemote(
    runGit(repoRoot, ["ls-remote", "--", remote, sourceRef]),
  );
  const current = refs.get(sourceRef) || null;
  if (!current) throw new Error(`Release source ref ${sourceRef} is missing`);
  if (current !== expectedCommit) {
    runGit(repoRoot, ["fetch", "--no-tags", "--quiet", remote, sourceRef]);
    assertFastForward(repoRoot, expectedCommit, current);
  }
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
 * Push only the planned `refs/tags/v<version>` ref. A failed push is re-read
 * once because the remote may have accepted the exact tag before the client
 * lost its response; only the exact canonical tag object converts that
 * ambiguity to an idempotent success.
 */
export function pushReleaseTag({ repoRoot, candidateDirectory, remote, tag }) {
  if (typeof remote !== "string" || remote.length === 0)
    throw new Error("An explicit Git remote is required");
  assertReleaseTagAllowed(tag);
  const tagRef = `refs/tags/${tag}`;
  assertRefName(repoRoot, tagRef);
  const { plan, state, planIntegrity } = verifyReleaseCandidate({
    repoRoot,
    candidateDirectory,
  });
  assertRemoteRepository(repoRoot, remote, plan.repository);
  assertTagMatchesPlan(tag, plan.version);
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
      `Git tag cannot be published from release phase ${state.phase}`,
    );
  }

  assertSourceStillReachable(repoRoot, remote, plan.sourceRef, expectedCommit);
  const canonicalTag = canonicalReleaseTag(
    repoRoot,
    tag,
    expectedCommit,
    plan,
    planIntegrity,
  );
  const bindingEvidence = {
    remote,
    remotePushUrls: resolveRemotePushUrls(repoRoot, remote),
    repository: plan.repository,
    sourceRef: plan.sourceRef,
    tagRef,
    tagObject: canonicalTag.objectId,
    taggerTimestamp: canonicalTag.taggerTimestamp,
    expectedCommit,
    cohortIntegrity: plan.cohortIntegrity,
    planIntegrity,
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

  const before = remoteReleaseRefs(
    repoRoot,
    remote,
    "refs/heads/__unused__",
    tagRef,
  );
  const exists = assertRemoteCanonicalTag(
    tagRef,
    before,
    expectedCommit,
    canonicalTag.objectId,
  );
  let pushed = false;
  if (!exists) {
    ensureLocalCanonicalTag(repoRoot, tagRef, canonicalTag);
    const push = spawnSync(
      "git",
      ["push", "--atomic", "--", remote, `${tagRef}:${tagRef}`],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (push.error) throw push.error;
    if (push.status === 0) {
      pushed = true;
    } else {
      const raced = remoteReleaseRefs(
        repoRoot,
        remote,
        "refs/heads/__unused__",
        tagRef,
      );
      try {
        const racedExists = assertRemoteCanonicalTag(
          tagRef,
          raced,
          expectedCommit,
          canonicalTag.objectId,
        );
        if (!racedExists) {
          throw new Error(`Remote tag ${tagRef} is still absent`);
        }
      } catch (error) {
        // error-policy:J2 retain the canonical-tag conflict behind the push failure
        const detail = [push.stdout, push.stderr]
          .filter(Boolean)
          .join("\n")
          .trim();
        throw new Error(`git push failed${detail ? `:\n${detail}` : ""}`, {
          cause: error,
        });
      }
    }
  }

  const after = remoteReleaseRefs(
    repoRoot,
    remote,
    "refs/heads/__unused__",
    tagRef,
  );
  assertRemoteCanonicalTag(
    tagRef,
    after,
    expectedCommit,
    canonicalTag.objectId,
  );
  const completionEvidence = {
    ...bindingEvidence,
    tagObject: after.tagObject,
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
  return {
    tagRef,
    tagObject: canonicalTag.objectId,
    expectedCommit,
    pushed,
  };
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
  const { plan, state, planIntegrity } = verifyReleaseCandidate({
    repoRoot,
    candidateDirectory,
  });
  assertRemoteRepository(repoRoot, remote, plan.repository);
  if (branchRef !== plan.sourceRef) {
    throw new Error(
      `Release branch ${branchRef} does not match planned source ref ${plan.sourceRef}`,
    );
  }
  assertTagMatchesPlan(tag, plan.version);
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

  const canonicalTag = canonicalReleaseTag(
    repoRoot,
    tag,
    expectedCommit,
    plan,
    planIntegrity,
  );

  const bindingEvidence = {
    remote,
    remotePushUrls: resolveRemotePushUrls(repoRoot, remote),
    repository: plan.repository,
    sourceRef: plan.sourceRef,
    branchRef,
    tagRef,
    tagObject: canonicalTag.objectId,
    taggerTimestamp: canonicalTag.taggerTimestamp,
    expectedCommit,
    expectedOldBranchSha: expectedOld,
    cohortIntegrity: plan.cohortIntegrity,
    planIntegrity,
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
  const tagExists = assertRemoteCanonicalTag(
    tagRef,
    before,
    expectedCommit,
    canonicalTag.objectId,
  );
  if (before.branchCommit !== expectedCommit) {
    if (before.branchCommit !== expectedOld) {
      throw new Error(
        `Remote branch ${branchRef} moved from ${expectedOld} to ${before.branchCommit}; rebase before release`,
      );
    }
    assertFastForward(repoRoot, before.branchCommit, expectedCommit);
  }
  if (!tagExists) ensureLocalCanonicalTag(repoRoot, tagRef, canonicalTag);

  const refspecs = [];
  const pushArgs = ["push", "--atomic"];
  if (before.branchCommit !== expectedCommit) {
    pushArgs.push(`--force-with-lease=${branchRef}:${expectedOld}`);
    refspecs.push(`${expectedCommit}:${branchRef}`);
  }
  if (!tagExists) refspecs.push(`${tagRef}:${tagRef}`);
  if (refspecs.length > 0)
    runGit(repoRoot, [...pushArgs, "--", remote, ...refspecs]);

  const after = remoteReleaseRefs(repoRoot, remote, branchRef, tagRef);
  if (after.branchCommit !== expectedCommit) {
    throw new Error(
      `Atomic ref verification failed: branch=${after.branchCommit}, expected=${expectedCommit}`,
    );
  }
  assertRemoteCanonicalTag(
    tagRef,
    after,
    expectedCommit,
    canonicalTag.objectId,
  );
  const completionEvidence = {
    ...bindingEvidence,
    branchCommit: after.branchCommit,
    tagObject: after.tagObject,
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
