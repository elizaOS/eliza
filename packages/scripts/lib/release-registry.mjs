/**
 * Inspects and publishes immutable release tarballs through an npm registry.
 * Only an HTTP 404 means absent; every authentication, throttling, transport,
 * server, or parse failure aborts, and an existing version resumes solely when
 * its registry integrity exactly matches the candidate bytes.
 */

import path from "node:path";
import {
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "./release-candidate.mjs";
import {
  RELEASE_PHASES,
  releaseTransitionEvidence,
  stableStringify,
  validateNpmPublisher,
  validateRegistryUrl,
} from "./release-contract.mjs";
import { spawnSync } from "./spawn-sync-captured.mjs";

export class RegistryInspectionError extends Error {
  constructor(message, { kind, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RegistryInspectionError";
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeRegistryUrl(registryUrl) {
  return validateRegistryUrl(registryUrl);
}

function registryHeaders(token) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function statusKind(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "throttling";
  if (status >= 500) return "server";
  return "unexpected-status";
}

async function requestRegistryJson(url, { token, allowMissing }) {
  let response;
  try {
    response = await fetch(url, {
      headers: registryHeaders(token),
      redirect: "error",
    });
  } catch (error) {
    // error-policy:J2 preserve the transport cause at the registry boundary
    throw new RegistryInspectionError(`Registry transport failed for ${url}`, {
      kind: "transport",
      cause: error,
    });
  }
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) {
    throw new RegistryInspectionError(
      `Registry returned HTTP ${response.status} for ${url}`,
      {
        kind: statusKind(response.status),
        status: response.status,
      },
    );
  }
  const source = await response.text();
  try {
    return JSON.parse(source);
  } catch (error) {
    // error-policy:J2 a successful status with malformed metadata is not absence
    throw new RegistryInspectionError(
      `Registry returned malformed JSON for ${url}`,
      {
        kind: "malformed-response",
        status: response.status,
        cause: error,
      },
    );
  }
}

function packageVersionUrl(registryUrl, packageName, version) {
  return new URL(
    `${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    registryUrl,
  ).toString();
}

function packageMetadataUrl(registryUrl, packageName) {
  return new URL(encodeURIComponent(packageName), registryUrl).toString();
}

/** Classify a registry version response without performing I/O. */
export function classifyRegistryVersion(
  packageRecord,
  metadata,
  { sourceSha, publisher, requireRegistryProvenance = true },
) {
  if (metadata === null) return { state: "missing" };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new RegistryInspectionError(
      `Malformed metadata for ${packageRecord.name}`,
      {
        kind: "malformed-response",
      },
    );
  }
  if (
    metadata.name !== packageRecord.name ||
    metadata.version !== packageRecord.version
  ) {
    throw new RegistryInspectionError(
      `Registry identity ${metadata.name}@${metadata.version} does not match ${packageRecord.name}@${packageRecord.version}`,
      { kind: "malformed-response" },
    );
  }
  const actualIntegrity = metadata.dist?.integrity;
  if (
    typeof actualIntegrity !== "string" ||
    !actualIntegrity.startsWith("sha512-")
  ) {
    throw new RegistryInspectionError(
      `Registry omitted SHA-512 integrity for ${packageRecord.name}`,
      {
        kind: "malformed-response",
      },
    );
  }
  if (actualIntegrity !== packageRecord.tarball.integrity) {
    return {
      state: "conflict",
      expectedIntegrity: packageRecord.tarball.integrity,
      actualIntegrity,
    };
  }
  const actualSourceSha = metadata.gitHead;
  const actualPublisher = metadata._npmUser?.name;
  const hasRegistryProvenance =
    actualSourceSha !== undefined || actualPublisher !== undefined;
  if (
    (hasRegistryProvenance &&
      (actualSourceSha !== sourceSha || actualPublisher !== publisher)) ||
    (!hasRegistryProvenance && requireRegistryProvenance)
  ) {
    throw new RegistryInspectionError(
      `Registry provenance for ${packageRecord.name}@${packageRecord.version} is ${actualPublisher ?? "missing"}/${actualSourceSha ?? "missing"}, expected ${publisher}/${sourceSha}`,
      { kind: "provenance-conflict" },
    );
  }
  return {
    state: "matched",
    integrity: actualIntegrity,
    sourceSha,
    publisher,
    provenance: hasRegistryProvenance
      ? "registry-metadata"
      : "candidate-integrity+authenticated-publisher",
  };
}

export async function inspectRegistryVersion({
  registryUrl,
  packageRecord,
  token,
  sourceSha,
  publisher,
}) {
  const registry = normalizeRegistryUrl(registryUrl);
  const metadata = await requestRegistryJson(
    packageVersionUrl(registry, packageRecord.name, packageRecord.version),
    { token, allowMissing: true },
  );
  return classifyRegistryVersion(packageRecord, metadata, {
    sourceSha,
    publisher,
    requireRegistryProvenance:
      new URL(registry).hostname === "registry.npmjs.org",
  });
}

/** Resolve the registry account behind a publication token before mutation. */
export async function inspectRegistryPublisher({ registryUrl, token }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Registry publication requires an explicit token");
  }
  const registry = normalizeRegistryUrl(registryUrl);
  const metadata = await requestRegistryJson(new URL("-/whoami", registry), {
    token,
    allowMissing: false,
  });
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    typeof metadata.username !== "string"
  ) {
    throw new RegistryInspectionError("Registry returned malformed whoami", {
      kind: "malformed-response",
    });
  }
  return validateNpmPublisher(metadata.username);
}

export async function inspectRegistryChannel({
  registryUrl,
  packageRecord,
  channel,
  token,
}) {
  const registry = normalizeRegistryUrl(registryUrl);
  const metadata = await requestRegistryJson(
    packageMetadataUrl(registry, packageRecord.name),
    {
      token,
      allowMissing: false,
    },
  );
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new RegistryInspectionError(
      `Malformed package metadata for ${packageRecord.name}`,
      {
        kind: "malformed-response",
      },
    );
  }
  const distTags = metadata["dist-tags"];
  if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new RegistryInspectionError(
      `Registry omitted dist-tags for ${packageRecord.name}`,
      {
        kind: "malformed-response",
      },
    );
  }
  const value = distTags[channel];
  if (value !== undefined && typeof value !== "string") {
    throw new RegistryInspectionError(
      `Registry returned malformed ${channel} tag for ${packageRecord.name}`,
      {
        kind: "malformed-response",
      },
    );
  }
  return value === undefined ? null : value;
}

export async function inspectReleaseRegistry({ registryUrl, plan, token }) {
  const records = [];
  for (const packageRecord of plan.packages) {
    records.push({
      name: packageRecord.name,
      version: packageRecord.version,
      ...(await inspectRegistryVersion({
        registryUrl,
        packageRecord,
        token,
        sourceSha: plan.sourceSha,
        publisher: plan.publisher,
      })),
    });
  }
  return records;
}

function assertNoRegistryConflicts(records) {
  const conflicts = records.filter(({ state }) => state === "conflict");
  if (conflicts.length > 0) {
    throw new Error(
      `Registry integrity conflict:\n${conflicts
        .map(
          ({ name, version, expectedIntegrity, actualIntegrity }) =>
            `  ${name}@${version}: expected ${expectedIntegrity}, received ${actualIntegrity}`,
        )
        .join("\n")}`,
    );
  }
}

function runNpm(npmCommand, args, { repoRoot, token }) {
  const env = { ...process.env };
  if (token) env.NODE_AUTH_TOKEN = token;
  const result = spawnSync(npmCommand, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `npm ${args[0]} failed with exit code ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

async function stageMissingPackages({
  repoRoot,
  candidateDirectory,
  registryUrl,
  plan,
  token,
  npmCommand,
}) {
  const initial = await inspectReleaseRegistry({ registryUrl, plan, token });
  assertNoRegistryConflicts(initial);
  const actions = [];
  for (const packageRecord of plan.packages) {
    const current = await inspectRegistryVersion({
      registryUrl,
      packageRecord,
      token,
      sourceSha: plan.sourceSha,
      publisher: plan.publisher,
    });
    if (current.state === "conflict") {
      assertNoRegistryConflicts([
        {
          name: packageRecord.name,
          version: packageRecord.version,
          ...current,
        },
      ]);
    }
    if (current.state === "matched") {
      actions.push({
        name: packageRecord.name,
        action: "integrity-matched-resume",
      });
      continue;
    }
    const args = [
      "publish",
      path.join(candidateDirectory, packageRecord.tarball.path),
      "--registry",
      normalizeRegistryUrl(registryUrl),
      "--tag",
      plan.candidateTag,
      "--ignore-scripts",
      "--provenance=false",
    ];
    if (packageRecord.name.startsWith("@")) args.push("--access", "public");
    runNpm(npmCommand, args, { repoRoot, token });
    actions.push({ name: packageRecord.name, action: "published" });
  }
  return actions;
}

async function verifyAllIntegrities({ registryUrl, plan, token }) {
  const records = await inspectReleaseRegistry({ registryUrl, plan, token });
  assertNoRegistryConflicts(records);
  const missing = records.filter(({ state }) => state === "missing");
  if (missing.length > 0) {
    throw new Error(
      `Registry is missing planned versions: ${missing.map(({ name }) => name).join(", ")}`,
    );
  }
  return records.map(({ name, version, integrity, provenance }) => ({
    name,
    version,
    integrity,
    sourceSha: plan.sourceSha,
    publisher: plan.publisher,
    provenance,
  }));
}

async function promoteChannel({
  repoRoot,
  registryUrl,
  plan,
  token,
  npmCommand,
}) {
  const actions = [];
  for (const packageRecord of plan.packages) {
    const actual = await inspectRegistryChannel({
      registryUrl,
      packageRecord,
      channel: plan.channel,
      token,
    });
    if (actual === packageRecord.version) {
      actions.push({ name: packageRecord.name, action: "already-promoted" });
      continue;
    }
    runNpm(
      npmCommand,
      [
        "dist-tag",
        "add",
        `${packageRecord.name}@${packageRecord.version}`,
        plan.channel,
        "--registry",
        normalizeRegistryUrl(registryUrl),
      ],
      { repoRoot, token },
    );
    actions.push({
      name: packageRecord.name,
      action: "promoted",
      previousVersion: actual,
    });
  }
  for (const packageRecord of plan.packages) {
    const actual = await inspectRegistryChannel({
      registryUrl,
      packageRecord,
      channel: plan.channel,
      token,
    });
    if (actual !== packageRecord.version) {
      throw new Error(
        `${packageRecord.name} channel ${plan.channel} points to ${actual}, expected ${packageRecord.version}`,
      );
    }
  }
  return actions;
}

async function removeCandidateTags({
  repoRoot,
  registryUrl,
  plan,
  token,
  npmCommand,
}) {
  const actions = [];
  for (const packageRecord of plan.packages) {
    const actual = await inspectRegistryChannel({
      registryUrl,
      packageRecord,
      channel: plan.candidateTag,
      token,
    });
    if (actual === null) {
      actions.push({ name: packageRecord.name, action: "already-removed" });
      continue;
    }
    if (actual !== packageRecord.version) {
      throw new Error(
        `${packageRecord.name} staging tag ${plan.candidateTag} points to ${actual}, expected ${packageRecord.version}`,
      );
    }
    runNpm(
      npmCommand,
      [
        "dist-tag",
        "rm",
        packageRecord.name,
        plan.candidateTag,
        "--registry",
        normalizeRegistryUrl(registryUrl),
      ],
      { repoRoot, token },
    );
    actions.push({ name: packageRecord.name, action: "removed" });
  }
  for (const packageRecord of plan.packages) {
    const actual = await inspectRegistryChannel({
      registryUrl,
      packageRecord,
      channel: plan.candidateTag,
      token,
    });
    if (actual !== null)
      throw new Error(
        `${packageRecord.name} still has staging tag ${plan.candidateTag}`,
      );
  }
  return actions;
}

/**
 * Re-read every immutable version and public channel after promotion. This is
 * the credential-free gate consumed by Git/GitHub finalization: a recorded
 * state is necessary for retry continuity, but live registry evidence remains
 * authoritative before any public ref advances.
 */
export async function verifyPromotedReleaseCandidate({
  repoRoot,
  candidateDirectory,
  registryUrl,
  token,
}) {
  const verified = verifyReleaseCandidate({ repoRoot, candidateDirectory });
  const phaseIndex = RELEASE_PHASES.indexOf(verified.state.phase);
  if (phaseIndex < RELEASE_PHASES.indexOf("channel-promoted")) {
    throw new Error(
      `Promoted registry verification requires channel-promoted state, received ${verified.state.phase}`,
    );
  }
  const normalizedRegistry = normalizeRegistryUrl(registryUrl);
  if (verified.plan.registry !== normalizedRegistry) {
    throw new Error(
      `Candidate registry is ${verified.plan.registry}, not ${normalizedRegistry}`,
    );
  }
  const recorded = releaseTransitionEvidence(verified.state, "registry-staged");
  if (
    recorded?.registry !== normalizedRegistry ||
    recorded?.publisher !== verified.plan.publisher
  ) {
    throw new Error(
      `Recorded registry identity is ${recorded?.registry}/${recorded?.publisher}, not ${normalizedRegistry}/${verified.plan.publisher}`,
    );
  }

  const packages = await verifyAllIntegrities({
    registryUrl: normalizedRegistry,
    plan: verified.plan,
    token,
  });
  const channels = [];
  for (const packageRecord of verified.plan.packages) {
    const channelVersion = await inspectRegistryChannel({
      registryUrl: normalizedRegistry,
      packageRecord,
      channel: verified.plan.channel,
      token,
    });
    if (channelVersion !== packageRecord.version) {
      throw new Error(
        `${packageRecord.name} channel ${verified.plan.channel} points to ${channelVersion}, expected ${packageRecord.version}`,
      );
    }
    const candidateVersion = await inspectRegistryChannel({
      registryUrl: normalizedRegistry,
      packageRecord,
      channel: verified.plan.candidateTag,
      token,
    });
    if (candidateVersion !== null) {
      throw new Error(
        `${packageRecord.name} still exposes staging tag ${verified.plan.candidateTag}`,
      );
    }
    channels.push({
      name: packageRecord.name,
      channel: verified.plan.channel,
      version: channelVersion,
      candidateTagRemoved: true,
    });
  }
  return {
    state: "channel-promoted",
    registry: normalizedRegistry,
    channel: verified.plan.channel,
    packages,
    channels,
    fingerprint: stableStringify({ packages, channels }),
  };
}

/** Stage, verify, and promote a candidate, resuming only matching state. */
export async function publishReleaseCandidate({
  repoRoot,
  candidateDirectory,
  registryUrl,
  token,
  npmCommand = "npm",
}) {
  const verified = verifyReleaseCandidate({ repoRoot, candidateDirectory });
  const { plan } = verified;
  let phaseIndex = RELEASE_PHASES.indexOf(verified.state.phase);
  const candidateIndex = RELEASE_PHASES.indexOf("candidate-recorded");
  const boundIndex = RELEASE_PHASES.indexOf("registry-bound");
  const stagedIndex = RELEASE_PHASES.indexOf("registry-staged");
  const promotedIndex = RELEASE_PHASES.indexOf("channel-promoted");
  const normalizedRegistry = normalizeRegistryUrl(registryUrl);
  if (plan.registry !== normalizedRegistry) {
    throw new Error(
      `Candidate registry is ${plan.registry}, not ${normalizedRegistry}`,
    );
  }
  const authenticatedPublisher = await inspectRegistryPublisher({
    registryUrl: normalizedRegistry,
    token,
  });
  if (authenticatedPublisher !== plan.publisher) {
    throw new Error(
      `Registry token identifies ${authenticatedPublisher}, expected ${plan.publisher}`,
    );
  }
  if (phaseIndex < candidateIndex)
    throw new Error(`Candidate is only at ${verified.state.phase}`);
  const bindingEvidence = {
    registry: normalizedRegistry,
    publisher: authenticatedPublisher,
    candidateTag: plan.candidateTag,
  };
  if (phaseIndex >= boundIndex) {
    const recorded = releaseTransitionEvidence(
      verified.state,
      "registry-bound",
    );
    if (
      recorded?.registry !== normalizedRegistry ||
      recorded?.publisher !== authenticatedPublisher
    ) {
      throw new Error(
        `Recorded registry identity is ${recorded?.registry}/${recorded?.publisher}, not ${normalizedRegistry}/${authenticatedPublisher}`,
      );
    }
    if (stableStringify(recorded) !== stableStringify(bindingEvidence))
      throw new Error("Candidate registry binding is malformed");
  }

  if (phaseIndex === candidateIndex) {
    recordReleaseTransition(
      candidateDirectory,
      "registry-bound",
      bindingEvidence,
    );
    phaseIndex = boundIndex;
  }

  if (phaseIndex === boundIndex) {
    const actions = await stageMissingPackages({
      repoRoot,
      candidateDirectory,
      registryUrl,
      plan,
      token,
      npmCommand,
    });
    recordReleaseTransition(candidateDirectory, "registry-staged", {
      ...bindingEvidence,
      actions,
    });
    phaseIndex = stagedIndex;
  }

  if (phaseIndex === stagedIndex) {
    const packages = await verifyAllIntegrities({ registryUrl, plan, token });
    recordReleaseTransition(candidateDirectory, "registry-verified", {
      registry: normalizedRegistry,
      packages,
    });
    phaseIndex += 1;
  }

  if (phaseIndex === RELEASE_PHASES.indexOf("registry-verified")) {
    // A retry may arrive long after the recorded verification. Re-read the
    // entire cohort immediately before any remaining public tag moves so state
    // history never substitutes for current registry integrity.
    await verifyAllIntegrities({ registryUrl, plan, token });
    const promotions = await promoteChannel({
      repoRoot,
      registryUrl,
      plan,
      token,
      npmCommand,
    });
    const candidateTagCleanup = await removeCandidateTags({
      repoRoot,
      registryUrl,
      plan,
      token,
      npmCommand,
    });
    recordReleaseTransition(candidateDirectory, "channel-promoted", {
      registry: normalizedRegistry,
      channel: plan.channel,
      promotions,
      candidateTagCleanup,
    });
    phaseIndex += 1;
  }

  if (phaseIndex >= promotedIndex) {
    return verifyPromotedReleaseCandidate({
      repoRoot,
      candidateDirectory,
      registryUrl,
      token,
    });
  }
  throw new Error(
    `Release publication stopped unexpectedly at ${RELEASE_PHASES[phaseIndex]}`,
  );
}
