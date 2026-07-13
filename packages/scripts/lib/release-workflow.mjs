/**
 * Validates the public workflow inputs that bind one source commit to one npm
 * channel and artifact identity. Beta accepts prerelease semver only; latest
 * accepts stable semver only, preventing a typo from promoting the wrong class
 * of version even when the lower-level registry contract is otherwise valid.
 */

import semver from "semver";
import {
  validateCommitSha,
  validateExactVersion,
  validateGitHubRepository,
  validateNpmPublisher,
  validateRegistryUrl,
  validateSourceRef,
} from "./release-contract.mjs";

const PUBLIC_CHANNELS = new Set(["beta", "latest"]);
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

export function validatePublicReleaseInputs({
  sourceSha,
  sourceRef,
  repository,
  registry,
  publisher,
  version,
  channel,
}) {
  const normalizedSourceSha = validateCommitSha(sourceSha, "sourceSha");
  const normalizedSourceRef = validateSourceRef(sourceRef);
  const normalizedRepository = validateGitHubRepository(repository);
  const normalizedRegistry = validateRegistryUrl(registry);
  const normalizedPublisher = validateNpmPublisher(publisher);
  if (normalizedRegistry !== PUBLIC_NPM_REGISTRY) {
    throw new Error(
      `Public npm releases require ${PUBLIC_NPM_REGISTRY}, received ${normalizedRegistry}`,
    );
  }
  const normalizedVersion = validateExactVersion(version);
  if (!PUBLIC_CHANNELS.has(channel)) {
    throw new Error(
      `Public npm channel must be beta or latest, received ${JSON.stringify(channel)}`,
    );
  }
  const prerelease = semver.prerelease(normalizedVersion) !== null;
  if (channel === "beta" && !prerelease) {
    throw new Error(`beta requires a prerelease version, received ${version}`);
  }
  if (channel === "latest" && prerelease) {
    throw new Error(`latest requires a stable version, received ${version}`);
  }
  return {
    sourceSha: normalizedSourceSha,
    sourceRef: normalizedSourceRef,
    repository: normalizedRepository,
    registry: normalizedRegistry,
    publisher: normalizedPublisher,
    version: normalizedVersion,
    channel,
    tag: `v${normalizedVersion}`,
    prerelease,
    artifactName: `npm-release-candidate-${normalizedSourceSha}-${normalizedVersion}-${channel}`,
  };
}
