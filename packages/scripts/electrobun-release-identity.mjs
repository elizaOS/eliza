/**
 * Resolves the canonical Electrobun release tag and verifies its existing
 * GitHub Release without creating or mutating either identity. The workflow
 * invokes this boundary before builds and again immediately before uploads so
 * a moved tag or conflicting release fails closed.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { validateGitHubRepository } from "./lib/release-contract.mjs";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const TAG_PATTERN =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_TAG_PEEL_DEPTH = 8;

export class ElectrobunReleaseIdentityError extends Error {
  constructor(message, { kind, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ElectrobunReleaseIdentityError";
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeGitHubApiUrl(apiUrl) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch (error) {
    // error-policy:J2 retain the invalid GitHub endpoint as context
    throw new ElectrobunReleaseIdentityError(
      `Invalid GitHub API URL ${apiUrl}`,
      { kind: "invalid-input", cause: error },
    );
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new ElectrobunReleaseIdentityError(
      "GitHub API URL must use HTTPS (HTTP is allowed only on loopback)",
      { kind: "invalid-input" },
    );
  }
  if (parsed.username || parsed.password) {
    throw new ElectrobunReleaseIdentityError(
      "GitHub API URL must not contain credentials",
      { kind: "invalid-input" },
    );
  }
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function statusKind(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not-found";
  if (status === 409 || status === 422) return "conflict";
  if (status === 429) return "throttling";
  if (status >= 500) return "server";
  return "unexpected-status";
}

async function requestGitHubJson(url, { token, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    // error-policy:J2 preserve the transport cause at the GitHub boundary
    throw new ElectrobunReleaseIdentityError(
      `GitHub transport failed for ${url}`,
      { kind: "transport", cause: error },
    );
  }
  if (!response.ok) {
    throw new ElectrobunReleaseIdentityError(
      `GitHub returned HTTP ${response.status} for ${url}`,
      { kind: statusKind(response.status), status: response.status },
    );
  }
  const source = await response.text();
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 malformed success output cannot prove release identity
    throw new ElectrobunReleaseIdentityError(
      `GitHub returned malformed JSON for ${url}`,
      { kind: "malformed-response", status: response.status, cause: error },
    );
  }
}

function repositoryPath(repository) {
  const [owner, name] = validateGitHubRepository(repository).split("/");
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function endpoint(apiUrl, repository, suffix) {
  return new URL(
    `${repositoryPath(repository)}/${suffix}`,
    normalizeGitHubApiUrl(apiUrl),
  ).toString();
}

function requireGitObject(value, context) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.object ||
    typeof value.object !== "object" ||
    Array.isArray(value.object) ||
    typeof value.object.type !== "string" ||
    typeof value.object.sha !== "string" ||
    !COMMIT_SHA_PATTERN.test(value.object.sha)
  ) {
    throw new ElectrobunReleaseIdentityError(
      `GitHub returned an invalid ${context} object`,
      { kind: "malformed-response" },
    );
  }
  return { type: value.object.type, sha: value.object.sha };
}

export function parseReleaseTag(tag) {
  if (typeof tag !== "string") {
    throw new ElectrobunReleaseIdentityError("Release tag must be a string", {
      kind: "invalid-input",
    });
  }
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new ElectrobunReleaseIdentityError(
      `Malformed release tag ${JSON.stringify(tag)}. Expected strict semver v<major>.<minor>.<patch> with optional prerelease/build suffix.`,
      { kind: "invalid-input" },
    );
  }
  const prerelease = match[4] ?? "";
  for (const identifier of prerelease.split(".")) {
    if (
      /^[0-9]+$/.test(identifier) &&
      identifier.length > 1 &&
      identifier[0] === "0"
    ) {
      throw new ElectrobunReleaseIdentityError(
        `Malformed release tag ${JSON.stringify(tag)}: numeric prerelease identifiers must not contain leading zeros.`,
        { kind: "invalid-input" },
      );
    }
  }
  return {
    tag,
    version: tag.slice(1),
    channel: prerelease ? "canary" : "stable",
    prerelease: prerelease.length > 0,
  };
}

export function selectReleaseTag({ inputTag, refType, refName }) {
  const selected = inputTag || (refType === "tag" ? refName : "");
  if (!selected) {
    throw new ElectrobunReleaseIdentityError(
      "Manual branch dispatches and reusable callers must provide an existing release tag",
      { kind: "invalid-input" },
    );
  }
  return parseReleaseTag(selected);
}

export async function resolveGitHubTag({
  apiUrl = "https://api.github.com/",
  repository,
  tag,
  token,
  fetchImpl = fetch,
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new ElectrobunReleaseIdentityError(
      "GitHub tag resolution requires a token",
      { kind: "invalid-input" },
    );
  }
  parseReleaseTag(tag);
  const ref = await requestGitHubJson(
    endpoint(apiUrl, repository, `git/ref/tags/${encodeURIComponent(tag)}`),
    { token, fetchImpl },
  );
  if (ref?.ref !== `refs/tags/${tag}`) {
    throw new ElectrobunReleaseIdentityError(
      `GitHub tag response did not identify refs/tags/${tag}`,
      { kind: "malformed-response" },
    );
  }
  let current = requireGitObject(ref, `tag reference ${tag}`);
  const seenTagObjects = new Set();
  let peelDepth = 0;
  while (current.type === "tag") {
    if (peelDepth >= MAX_TAG_PEEL_DEPTH || seenTagObjects.has(current.sha)) {
      throw new ElectrobunReleaseIdentityError(
        `Tag ${tag} did not resolve to a commit within ${MAX_TAG_PEEL_DEPTH} annotated tag objects`,
        { kind: "conflict" },
      );
    }
    seenTagObjects.add(current.sha);
    const tagObject = await requestGitHubJson(
      endpoint(apiUrl, repository, `git/tags/${current.sha}`),
      { token, fetchImpl },
    );
    current = requireGitObject(tagObject, `annotated tag ${current.sha}`);
    peelDepth += 1;
  }
  if (current.type !== "commit") {
    throw new ElectrobunReleaseIdentityError(
      `Resolved tag target type '${current.type}' is not a commit`,
      { kind: "conflict" },
    );
  }
  return { sourceSha: current.sha, peelDepth };
}

export async function resolveElectrobunReleaseSource({
  apiUrl,
  repository,
  inputTag,
  refType,
  refName,
  eventName,
  eventSha,
  token,
  fetchImpl,
}) {
  const identity = selectReleaseTag({ inputTag, refType, refName });
  const resolved = await resolveGitHubTag({
    apiUrl,
    repository,
    tag: identity.tag,
    token,
    fetchImpl,
  });
  if (eventName === "push" && eventSha !== resolved.sourceSha) {
    throw new ElectrobunReleaseIdentityError(
      `Push event SHA ${eventSha} does not match peeled tag commit ${resolved.sourceSha}`,
      { kind: "conflict" },
    );
  }
  return { ...identity, ...resolved };
}

export async function verifyExistingElectrobunRelease({
  apiUrl,
  repository,
  tag,
  expectedCommit,
  token,
  fetchImpl,
}) {
  const identity = parseReleaseTag(tag);
  if (!COMMIT_SHA_PATTERN.test(expectedCommit)) {
    throw new ElectrobunReleaseIdentityError(
      `Expected release commit '${expectedCommit}' is not a full commit SHA`,
      { kind: "invalid-input" },
    );
  }
  const resolved = await resolveGitHubTag({
    apiUrl,
    repository,
    tag,
    token,
    fetchImpl,
  });
  if (resolved.sourceSha !== expectedCommit) {
    throw new ElectrobunReleaseIdentityError(
      `Release tag ${tag} moved from prepared commit ${expectedCommit} to ${resolved.sourceSha}`,
      { kind: "conflict" },
    );
  }
  const release = await requestGitHubJson(
    endpoint(apiUrl, repository, `releases/tags/${encodeURIComponent(tag)}`),
    { token, fetchImpl },
  );
  if (
    !release ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== tag ||
    release.target_commitish !== expectedCommit ||
    release.draft !== false ||
    release.prerelease !== identity.prerelease
  ) {
    throw new ElectrobunReleaseIdentityError(
      `GitHub Release for ${tag} does not match prepared commit ${expectedCommit} and canonical publication state`,
      { kind: "conflict" },
    );
  }
  return {
    releaseId: release.id,
    sourceSha: resolved.sourceSha,
    tag,
    prerelease: identity.prerelease,
  };
}

function parseCli(argv) {
  const [command, ...tokens] = argv;
  if (command !== "resolve" && command !== "verify") {
    throw new ElectrobunReleaseIdentityError(
      "Usage: electrobun-release-identity.mjs <resolve|verify> [options]",
      { kind: "invalid-input" },
    );
  }
  const options = Object.create(null);
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new ElectrobunReleaseIdentityError(
        `Invalid CLI argument near '${flag ?? ""}'`,
        { kind: "invalid-input" },
      );
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      throw new ElectrobunReleaseIdentityError(
        `Duplicate CLI option --${key}`,
        { kind: "invalid-input" },
      );
    }
    options[key] = value;
  }
  const allowed =
    command === "resolve"
      ? new Set([
          "api-url",
          "event-name",
          "event-sha",
          "github-output",
          "input-tag",
          "ref-name",
          "ref-type",
          "repository",
        ])
      : new Set(["api-url", "expected-commit", "repository", "tag"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new ElectrobunReleaseIdentityError(
        `Unknown option --${key} for ${command}`,
        { kind: "invalid-input" },
      );
    }
  }
  return { command, options };
}

function requiredOption(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ElectrobunReleaseIdentityError(
      `Missing required option --${key}`,
      { kind: "invalid-input" },
    );
  }
  return value;
}

async function runCli(argv) {
  const { command, options } = parseCli(argv);
  const readEnvironment = (name) => process.env[name];
  const common = {
    apiUrl: options["api-url"] || readEnvironment("GITHUB_API_URL"),
    repository: requiredOption(options, "repository"),
    token: readEnvironment("GH_TOKEN"),
  };
  if (command === "resolve") {
    const result = await resolveElectrobunReleaseSource({
      ...common,
      inputTag: options["input-tag"] ?? "",
      refType: options["ref-type"] ?? "",
      refName: options["ref-name"] ?? "",
      eventName: options["event-name"] ?? "",
      eventSha: options["event-sha"] ?? "",
    });
    const githubOutput = requiredOption(options, "github-output");
    fs.appendFileSync(
      githubOutput,
      `tag=${result.tag}\nversion=${result.version}\nenv=${result.channel}\nsource_sha=${result.sourceSha}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ...result, repository: common.repository })}\n`,
    );
    return;
  }
  const result = await verifyExistingElectrobunRelease({
    ...common,
    tag: requiredOption(options, "tag"),
    expectedCommit: requiredOption(options, "expected-commit"),
  });
  process.stdout.write(
    `${JSON.stringify({ ...result, repository: common.repository })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    // error-policy:J1 CLI boundary returns a sanitized, typed failure
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[electrobun-release-identity] ${message}\n`);
    process.exitCode = 1;
  });
}
