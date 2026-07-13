/**
 * Publishes the GitHub Release only after npm verification and exact Git-tag
 * publication. The boundary creates one non-draft release, re-reads it from the
 * API, and treats retries as idempotent only when tag and prerelease identity
 * still match the immutable candidate.
 */

import {
  loadReleaseState,
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "./release-candidate.mjs";
import {
  RELEASE_PHASES,
  releaseTransitionEvidence,
  stableStringify,
} from "./release-contract.mjs";

export class GitHubReleaseError extends Error {
  constructor(message, { kind, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "GitHubReleaseError";
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeGitHubApiUrl(apiUrl) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch (error) {
    // error-policy:J2 retain the invalid finalization endpoint as context
    throw new Error(`Invalid GitHub API URL ${apiUrl}`, { cause: error });
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new Error(
      "GitHub API URL must use HTTPS (HTTP is allowed only on loopback)",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("GitHub API URL must not contain credentials");
  }
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function validateRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(repository)}`);
  }
  return repository;
}

function statusKind(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 409 || status === 422) return "conflict";
  if (status === 429) return "throttling";
  if (status >= 500) return "server";
  return "unexpected-status";
}

async function requestGitHubJson(
  url,
  { token, method = "GET", body, allowMissing = false },
) {
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // error-policy:J2 preserve the transport cause at the GitHub boundary
    throw new GitHubReleaseError(`GitHub transport failed for ${url}`, {
      kind: "transport",
      cause: error,
    });
  }
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) {
    throw new GitHubReleaseError(
      `GitHub returned HTTP ${response.status} for ${url}`,
      { kind: statusKind(response.status), status: response.status },
    );
  }
  const source = await response.text();
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 successful malformed API output cannot prove publication
    throw new GitHubReleaseError(`GitHub returned malformed JSON for ${url}`, {
      kind: "malformed-response",
      status: response.status,
      cause: error,
    });
  }
}

function releaseEndpoint(apiUrl, repository, tag) {
  const [owner, name] = validateRepository(repository).split("/");
  return new URL(
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/tags/${encodeURIComponent(tag)}`,
    normalizeGitHubApiUrl(apiUrl),
  ).toString();
}

function releasesEndpoint(apiUrl, repository) {
  const [owner, name] = validateRepository(repository).split("/");
  return new URL(
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases`,
    normalizeGitHubApiUrl(apiUrl),
  ).toString();
}

function validatePublishedRelease(release, { tag, prerelease }) {
  if (
    !release ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== prerelease ||
    typeof release.html_url !== "string" ||
    release.html_url.length === 0
  ) {
    throw new GitHubReleaseError(
      `GitHub release for ${tag} does not match the planned public identity`,
      { kind: "conflict" },
    );
  }
  return release;
}

/** Create or verify the exact non-draft GitHub Release for a tagged candidate. */
export async function publishGitHubRelease({
  repoRoot,
  candidateDirectory,
  repository,
  tag,
  token,
  apiUrl = "https://api.github.com/",
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GitHub release publication requires a token");
  }
  const normalizedApiUrl = normalizeGitHubApiUrl(apiUrl);
  const verified = verifyReleaseCandidate({ repoRoot, candidateDirectory });
  if (tag !== `v${verified.plan.version}`) {
    throw new Error(
      `GitHub release tag must be exactly v${verified.plan.version}, received ${tag}`,
    );
  }
  const phaseIndex = RELEASE_PHASES.indexOf(verified.state.phase);
  if (phaseIndex < RELEASE_PHASES.indexOf("git-tagged")) {
    throw new Error(
      `GitHub release cannot be published from phase ${verified.state.phase}`,
    );
  }
  const gitEvidence = releaseTransitionEvidence(verified.state, "git-tagged");
  if (
    gitEvidence?.tagRef !== `refs/tags/${tag}` ||
    gitEvidence?.expectedCommit !== verified.plan.expectedCommit
  ) {
    throw new Error(
      "Git-tag evidence does not match the planned GitHub release",
    );
  }

  const prerelease = verified.plan.channel !== "latest";
  const endpoint = releaseEndpoint(normalizedApiUrl, repository, tag);
  let release = await requestGitHubJson(endpoint, {
    token,
    allowMissing: true,
  });
  let created = false;
  if (release === null) {
    await requestGitHubJson(releasesEndpoint(normalizedApiUrl, repository), {
      token,
      method: "POST",
      body: {
        tag_name: tag,
        target_commitish: verified.plan.expectedCommit,
        name: tag,
        draft: false,
        prerelease,
        generate_release_notes: true,
      },
    });
    created = true;
    release = await requestGitHubJson(endpoint, { token });
  }
  validatePublishedRelease(release, { tag, prerelease });
  const evidence = {
    apiUrl: normalizedApiUrl,
    repository: validateRepository(repository),
    tag,
    expectedCommit: verified.plan.expectedCommit,
    releaseId: release.id,
    url: release.html_url,
    prerelease,
  };
  if (phaseIndex >= RELEASE_PHASES.indexOf("release-published")) {
    const recorded = releaseTransitionEvidence(
      loadReleaseState(candidateDirectory).state,
      "release-published",
    );
    if (stableStringify(recorded) !== stableStringify(evidence)) {
      throw new Error(
        "Conflicting evidence for already-recorded phase release-published",
      );
    }
  } else {
    recordReleaseTransition(candidateDirectory, "release-published", evidence);
  }
  return { ...evidence, created };
}
