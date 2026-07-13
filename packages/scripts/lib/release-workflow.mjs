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
} from "./release-contract.mjs";

const PUBLIC_CHANNELS = new Set(["beta", "latest"]);

export function validatePublicReleaseInputs({ sourceSha, version, channel }) {
  const normalizedSourceSha = validateCommitSha(sourceSha, "sourceSha");
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
    version: normalizedVersion,
    channel,
    tag: `v${normalizedVersion}`,
    prerelease,
    artifactName: `npm-release-candidate-${normalizedSourceSha}-${normalizedVersion}-${channel}`,
  };
}
