/**
 * Defines the only repository origins the managed app builder may fetch.
 * Both deploy admission and the BuildKit sink use this canonicalizer so stored
 * metadata cannot bypass the public API's validation boundary.
 */

import { ElizaError } from "@elizaos/core";

const GITHUB_REPOSITORY_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const GITHUB_REPOSITORY_SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

function containsEncodedOrControlCharacters(value: string): boolean {
  return (
    value.includes("%") ||
    value.includes("\\") ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

function unsafeRepositoryUrl(value: string): ElizaError {
  return new ElizaError(
    "App builds require an HTTPS repository on the canonical github.com origin",
    {
      code: "APP_BUILD_REPOSITORY_URL_UNSAFE",
      context: { repoUrl: value },
      severity: "fatal",
    },
  );
}

function canonicalRepository(owner: string, repository: string, raw: string): string {
  const repositoryName = repository.endsWith(".git")
    ? repository.slice(0, -".git".length)
    : repository;
  if (
    !repositoryName ||
    owner === "." ||
    owner === ".." ||
    repositoryName === "." ||
    repositoryName === ".." ||
    owner.startsWith(".") ||
    repositoryName.startsWith(".")
  ) {
    throw unsafeRepositoryUrl(raw);
  }
  return `https://github.com/${owner}/${repositoryName}.git`;
}

/**
 * Return a canonical GitHub clone URL or fail closed.
 *
 * The fixed origin is deliberate: BuildKit performs its own DNS resolution and
 * follows Git redirects, so a preflight request/IP check cannot pin the later
 * connection. Restricting the sink to GitHub removes caller-controlled DNS,
 * redirect, credential, private-address, and alternate-encoding targets.
 */
export function canonicalizeAppBuildRepoUrl(raw: string): string {
  const value = raw.trim();
  if (!value || containsEncodedOrControlCharacters(value)) {
    throw unsafeRepositoryUrl(raw);
  }

  const shorthand = GITHUB_REPOSITORY_SHORTHAND.exec(value);
  if (shorthand) {
    return canonicalRepository(shorthand[1], shorthand[2], raw);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    // error-policy:J2 context-adding rethrow; retain URL's parse failure while classifying the build-source boundary.
    throw new ElizaError("App build repository URL is invalid", {
      code: "APP_BUILD_REPOSITORY_URL_INVALID",
      context: { repoUrl: raw },
      cause,
      severity: "fatal",
    });
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw unsafeRepositoryUrl(raw);
  }

  const path = GITHUB_REPOSITORY_PATH.exec(parsed.pathname);
  if (!path) {
    throw unsafeRepositoryUrl(raw);
  }
  return canonicalRepository(path[1], path[2], raw);
}
