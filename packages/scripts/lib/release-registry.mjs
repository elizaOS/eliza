/**
 * Inspects and publishes immutable release tarballs through an npm registry.
 * Only an HTTP 404 means absent; every authentication, throttling, transport,
 * server, or parse failure aborts, and an existing version resumes solely when
 * its registry integrity exactly matches the candidate bytes.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "./release-candidate.mjs";
import {
  RELEASE_PHASES,
  releaseTransitionEvidence,
  stableStringify,
} from "./release-contract.mjs";

export class RegistryInspectionError extends Error {
  constructor(message, { kind, status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RegistryInspectionError";
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeRegistryUrl(registryUrl) {
  let parsed;
  try {
    parsed = new URL(registryUrl);
  } catch (error) {
    // error-policy:J2 the registry boundary needs the rejected input in context
    throw new Error(`Invalid registry URL ${registryUrl}`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Registry URL must use http or https: ${registryUrl}`);
  }
  if (parsed.username || parsed.password)
    throw new Error("Registry URL must not contain credentials");
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
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
export function classifyRegistryVersion(packageRecord, metadata) {
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
  return { state: "matched", integrity: actualIntegrity };
}

export async function inspectRegistryVersion({
  registryUrl,
  packageRecord,
  token,
}) {
  const registry = normalizeRegistryUrl(registryUrl);
  const metadata = await requestRegistryJson(
    packageVersionUrl(registry, packageRecord.name, packageRecord.version),
    { token, allowMissing: true },
  );
  return classifyRegistryVersion(packageRecord, metadata);
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
      ...(await inspectRegistryVersion({ registryUrl, packageRecord, token })),
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
  return records.map(({ name, version, integrity }) => ({
    name,
    version,
    integrity,
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
  if (phaseIndex < candidateIndex)
    throw new Error(`Candidate is only at ${verified.state.phase}`);
  const bindingEvidence = {
    registry: normalizedRegistry,
    candidateTag: plan.candidateTag,
  };
  if (phaseIndex >= boundIndex) {
    const recorded = releaseTransitionEvidence(
      verified.state,
      "registry-bound",
    );
    if (recorded?.registry !== normalizedRegistry) {
      throw new Error(
        `Candidate registry is ${recorded?.registry}, not ${normalizedRegistry}`,
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
    const packages = await verifyAllIntegrities({ registryUrl, plan, token });
    for (const packageRecord of plan.packages) {
      const actual = await inspectRegistryChannel({
        registryUrl,
        packageRecord,
        channel: plan.channel,
        token,
      });
      if (actual !== packageRecord.version) {
        throw new Error(
          `${packageRecord.name} is no longer promoted on ${plan.channel}`,
        );
      }
    }
    return {
      state: "channel-promoted",
      packages,
      fingerprint: stableStringify(packages),
    };
  }
  throw new Error(
    `Release publication stopped unexpectedly at ${RELEASE_PHASES[phaseIndex]}`,
  );
}
