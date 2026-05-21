/**
 * TEE full-stack local harness (plan §7 Phase A item A1).
 *
 * A runnable, self-checking, hardware-free end-to-end exercise of the
 * confidential-AI trust pipeline:
 *
 *   collect TeeEvidence
 *     -> evaluateTeeEvidencePolicy (the single trust decision)
 *       -> HttpTeeKeyReleaseClient -> mock KMS (wrapTeeReleaseKey)
 *
 * It defines the three deployment topologies the product supports
 * (local-only, desktop, cloud-routed), drives a golden (trusted) key release
 * for each, and then drives a golden + tampered fixture for EVERY decision
 * reason in the closed `TeeEvidencePolicyDecision` union, asserting the exact
 * reason each time. Artifacts are written under evidence/tee/.
 *
 * This is NOT the unit test (tee-evidence-policy.matrix.test.ts owns the pure
 * data matrix). This script wires the same vectors through the real key-release
 * client + mock KMS so the wrap/unwrap, nonce, and report_data binding paths are
 * exercised end to end. Real TDX/CoVE quote-signature verification is BLOCKED on
 * hardware (plan Phase B/C); this verifies a normalized evidence document only.
 *
 * Run: bun packages/agent/scripts/tee-full-stack-local.ts
 * Exit: 0 on all-green, non-zero on any mismatch.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type SealedWeightsBlob,
  unsealModelWeights,
} from "../src/services/tee-confidential-inference.ts";
import type {
  TeeEvidence,
  TeeMeasurementName,
} from "../src/services/tee-evidence.ts";
import {
  HttpTeeKeyReleaseClient,
  type TeeReportDataBoundEvidenceProvider,
  wrapTeeReleaseKey,
} from "../src/services/tee-key-release.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "../src/services/tee-policy.ts";
import { mergeTeeProductionProfile } from "../src/services/tee-production-profile.ts";
import {
  mergeTeeRevocationsIntoPolicy,
  type TeeRevocationManifest,
} from "../src/services/tee-revocation.ts";

// Fixed clock so timestamp-freshness vectors are deterministic.
const NOW = Date.parse("2026-05-20T12:00:00.000Z");
const FRESH_TIMESTAMP = "2026-05-20T11:59:30.000Z"; // 30s old, inside every topology window.
const ISSUED_NONCE = "issued-nonce-full-stack-local";

// Deterministic golden measurement digests. Distinct per name so a tamper of
// one cannot accidentally collide with another.
const digest = (label: string) =>
  `sha256:${createHash("sha256").update(`golden:${label}`).digest("hex")}`;

const GOLDEN_MEASUREMENTS: Record<TeeMeasurementName, string> = {
  boot: digest("boot"),
  os: digest("os"),
  agent: digest("agent"),
  policy: digest("policy"),
  device: digest("device"),
  container: digest("container"),
  npuFirmware: digest("npuFirmware"),
  gpuFirmware: digest("gpuFirmware"),
};

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

// ---------------------------------------------------------------------------
// Topology policies. Each is the production profile (which forces required,
// rejectSimulatedEvidence, the base claims, and a 5-min freshness floor)
// merged with the topology's allowlists, golden digests, nonce, and clock.
// ---------------------------------------------------------------------------

type Topology = "local-only" | "desktop" | "cloud-routed";

type TopologyFixture = {
  topology: Topology;
  /** The golden evidence the in-domain attestation agent would emit. */
  evidence: TeeEvidence;
  /** Policy the agent evaluates (production profile + topology specifics). */
  policy: TeeEvidencePolicy;
  /** KMS provider id this topology releases keys against. */
  kmsProvider: string;
  /** Key-release scope exercised for this topology. */
  keyId: string;
};

function buildLocalOnly(): TopologyFixture {
  // Local-only: on-device CVM/TVM, on-device verifier, NPU confidential I/O.
  // required + npuProtected + local golden digests (boot/os/agent/policy/
  // device/container/npuFirmware). No cloud provider.
  const evidence: TeeEvidence = {
    kind: "cove",
    provider: "eliza-vault",
    hardwareVendor: "elizaos-e1",
    platformVersion: "local-only-cove",
    securityVersion: 7,
    measurements: {
      boot: GOLDEN_MEASUREMENTS.boot,
      os: GOLDEN_MEASUREMENTS.os,
      agent: GOLDEN_MEASUREMENTS.agent,
      policy: GOLDEN_MEASUREMENTS.policy,
      device: GOLDEN_MEASUREMENTS.device,
      container: GOLDEN_MEASUREMENTS.container,
      npuFirmware: GOLDEN_MEASUREMENTS.npuFirmware,
    },
    freshness: {
      nonce: ISSUED_NONCE,
      timestamp: FRESH_TIMESTAMP,
      verifier: "eliza-e1-verifier",
    },
    claims: {
      debugDisabled: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      productionLifecycle: true,
      npuProtected: true,
    },
  };
  const policy = mergeTeeProductionProfile(
    {
      allowedKinds: ["cove"],
      allowedProviders: ["eliza-vault"],
      minSecurityVersion: 7,
      expectedNonce: ISSUED_NONCE,
      maxAgeMs: 60_000,
      nowMs: NOW,
      requiredMeasurements: {
        boot: GOLDEN_MEASUREMENTS.boot,
        os: GOLDEN_MEASUREMENTS.os,
        agent: GOLDEN_MEASUREMENTS.agent,
        policy: GOLDEN_MEASUREMENTS.policy,
        device: GOLDEN_MEASUREMENTS.device,
        container: GOLDEN_MEASUREMENTS.container,
        npuFirmware: GOLDEN_MEASUREMENTS.npuFirmware,
      },
    },
    { inference: "local" },
  );
  return {
    topology: "local-only",
    evidence,
    policy,
    kmsProvider: "eliza-e1-verifier",
    keyId: "model-key",
  };
}

function buildDesktop(): TopologyFixture {
  // Desktop: local agent in a dstack CVM (TDX) on a workstation. Local private
  // inference (npuProtected) but no on-chip NPU firmware gate — the desktop
  // attests boot/os/agent/policy/device/container only.
  const evidence: TeeEvidence = {
    kind: "dstack",
    provider: "dstack",
    hardwareVendor: "intel",
    platformVersion: "desktop-tdx",
    securityVersion: 5,
    measurements: {
      boot: GOLDEN_MEASUREMENTS.boot,
      os: GOLDEN_MEASUREMENTS.os,
      agent: GOLDEN_MEASUREMENTS.agent,
      policy: GOLDEN_MEASUREMENTS.policy,
      device: GOLDEN_MEASUREMENTS.device,
      container: GOLDEN_MEASUREMENTS.container,
    },
    freshness: {
      nonce: ISSUED_NONCE,
      timestamp: FRESH_TIMESTAMP,
      verifier: "intel-pcs",
    },
    claims: {
      debugDisabled: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      productionLifecycle: true,
      npuProtected: true,
    },
  };
  const policy = mergeTeeProductionProfile(
    {
      allowedKinds: ["dstack"],
      allowedProviders: ["dstack"],
      minSecurityVersion: 5,
      expectedNonce: ISSUED_NONCE,
      maxAgeMs: 120_000,
      nowMs: NOW,
      requiredMeasurements: {
        boot: GOLDEN_MEASUREMENTS.boot,
        os: GOLDEN_MEASUREMENTS.os,
        agent: GOLDEN_MEASUREMENTS.agent,
        policy: GOLDEN_MEASUREMENTS.policy,
        device: GOLDEN_MEASUREMENTS.device,
        container: GOLDEN_MEASUREMENTS.container,
      },
    },
    { inference: "local" },
  );
  return {
    topology: "desktop",
    evidence,
    policy,
    kmsProvider: "dstack",
    keyId: "agent-session",
  };
}

function buildCloudRouted(): TopologyFixture {
  // Cloud-routed: prompt data goes to a dstack CVM on TDX + H100 confidential
  // GPU. Adds the cloud KMS provider, requires gpuProtected + gpuFirmware.
  const evidence: TeeEvidence = {
    kind: "tdx",
    provider: "eliza-cloud-kms",
    hardwareVendor: "intel",
    platformVersion: "cloud-tdx-h100",
    securityVersion: 9,
    measurements: {
      boot: GOLDEN_MEASUREMENTS.boot,
      os: GOLDEN_MEASUREMENTS.os,
      agent: GOLDEN_MEASUREMENTS.agent,
      policy: GOLDEN_MEASUREMENTS.policy,
      device: GOLDEN_MEASUREMENTS.device,
      container: GOLDEN_MEASUREMENTS.container,
      gpuFirmware: GOLDEN_MEASUREMENTS.gpuFirmware,
    },
    freshness: {
      nonce: ISSUED_NONCE,
      timestamp: FRESH_TIMESTAMP,
      verifier: "intel-pcs",
    },
    claims: {
      debugDisabled: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      productionLifecycle: true,
      gpuProtected: true,
    },
  };
  const policy = mergeTeeProductionProfile(
    {
      allowedKinds: ["tdx"],
      // Cloud-routed adds the cloud KMS provider to the allowlist.
      allowedProviders: ["dstack", "eliza-cloud-kms"],
      minSecurityVersion: 9,
      expectedNonce: ISSUED_NONCE,
      maxAgeMs: 60_000,
      nowMs: NOW,
      requiredMeasurements: {
        boot: GOLDEN_MEASUREMENTS.boot,
        os: GOLDEN_MEASUREMENTS.os,
        agent: GOLDEN_MEASUREMENTS.agent,
        policy: GOLDEN_MEASUREMENTS.policy,
        device: GOLDEN_MEASUREMENTS.device,
        container: GOLDEN_MEASUREMENTS.container,
        gpuFirmware: GOLDEN_MEASUREMENTS.gpuFirmware,
      },
    },
    { inference: "cloud" },
  );
  return {
    topology: "cloud-routed",
    evidence,
    policy,
    kmsProvider: "eliza-cloud-kms",
    keyId: "remote-signing",
  };
}

const topologies: TopologyFixture[] = [
  buildLocalOnly(),
  buildDesktop(),
  buildCloudRouted(),
];

// ---------------------------------------------------------------------------
// Mock KMS: verifies the same policy the agent evaluates, then wraps the
// released key to the agent's ephemeral public key with wrapTeeReleaseKey so
// the client's unwrap (X25519 ECDH + HKDF + AES-256-GCM) succeeds.
// ---------------------------------------------------------------------------

function makeMockKmsFetch(kmsSecretLabel: string): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      keyId: string;
      nonce: string;
      ephemeralPublicKey: string;
      reportData: string;
      evidence: TeeEvidence;
      policy: TeeEvidencePolicy;
    };
    const decision = evaluateTeeEvidencePolicy(body.evidence, body.policy);
    if (!decision.trusted) {
      return Response.json({ decision }, { status: 403 });
    }
    // Deterministic per-app key bound to the measured agent/policy identity,
    // mirroring dstack's deterministic-app-key model.
    const keyMaterialHex = createHash("sha256")
      .update(kmsSecretLabel)
      .update(body.keyId)
      .update(body.evidence.measurements?.agent ?? "")
      .update(body.evidence.measurements?.policy ?? "")
      .digest("hex");
    const wrappedKey = wrapTeeReleaseKey({
      keyMaterialHex,
      agentEphemeralPublicKeyDerBase64: body.ephemeralPublicKey,
      nonceHex: body.nonce,
    });
    return Response.json({
      keyId: body.keyId,
      nonce: body.nonce,
      wrappedKey,
      decision,
    });
  }) as typeof fetch;
}

function makeEvidenceProvider(
  fixture: TopologyFixture,
): TeeReportDataBoundEvidenceProvider {
  return {
    id: `full-stack-${fixture.topology}`,
    collectEvidence: async () => fixture.evidence,
    collectEvidenceWithReportData: async ({ nonce, reportDataHex }) => ({
      ...fixture.evidence,
      reportData: reportDataHex,
      freshness: { ...fixture.evidence.freshness, nonce },
    }),
  };
}

type TopologyRunResult = {
  topology: Topology;
  kmsProvider: string;
  keyId: string;
  golden: ReturnType<typeof summarize>;
  keyMaterialSha256: string;
  ok: boolean;
};

async function runTopology(
  fixture: TopologyFixture,
): Promise<TopologyRunResult> {
  const golden = evaluateTeeEvidencePolicy(fixture.evidence, fixture.policy);
  const client = new HttpTeeKeyReleaseClient({
    baseUrl: "https://kms.example.test",
    fetch: makeMockKmsFetch(`full-stack-${fixture.topology}-kms`),
    evidenceProvider: makeEvidenceProvider(fixture),
  });
  const release = await client.releaseKey({
    keyId: fixture.keyId,
    context: `full-stack-${fixture.topology}`,
    policy: fixture.policy,
  });
  const keyMaterialSha256 = createHash("sha256")
    .update(release.keyMaterialHex)
    .digest("hex");
  const ok =
    golden.trusted &&
    golden.reason === "allowed" &&
    release.decision.trusted &&
    /^[a-f0-9]{64}$/.test(release.keyMaterialHex) &&
    release.keyId === fixture.keyId;
  return {
    topology: fixture.topology,
    kmsProvider: fixture.kmsProvider,
    keyId: fixture.keyId,
    golden: summarize(golden),
    keyMaterialSha256,
    ok,
  };
}

// ---------------------------------------------------------------------------
// Decision-reason matrix. A golden (trusted) base + a tampered variant per
// reason in the closed union. The base is the cloud-routed evidence/policy
// (richest measurement + claim set). Each tampered case asserts the EXACT
// reason the policy must return; the harness exits non-zero on any mismatch.
// ---------------------------------------------------------------------------

const REASON_BASE_FIXTURE = buildCloudRouted();
const reasonBaseEvidence = REASON_BASE_FIXTURE.evidence;
const reasonBasePolicy = REASON_BASE_FIXTURE.policy;

type ReasonVector = {
  reason: TeeEvidencePolicyDecision["reason"];
  evidence: unknown;
  policy: TeeEvidencePolicy | undefined;
  trusted: boolean;
};

const reasonVectors: ReasonVector[] = [
  // Trusted reasons.
  { reason: "no-policy", evidence: reasonBaseEvidence, policy: undefined, trusted: true },
  {
    reason: "not-required",
    evidence: undefined,
    policy: { required: false },
    trusted: true,
  },
  {
    reason: "allowed",
    evidence: reasonBaseEvidence,
    policy: reasonBasePolicy,
    trusted: true,
  },
  // Untrusted reasons (golden base, one field tampered each).
  {
    reason: "missing-evidence",
    evidence: undefined,
    policy: { required: true },
    trusted: false,
  },
  {
    reason: "invalid-evidence",
    // No `kind` → normalizeTeeEvidence throws → invalid-evidence.
    evidence: { provider: "eliza-cloud-kms" },
    policy: { required: true },
    trusted: false,
  },
  {
    reason: "simulated-evidence-rejected",
    // Production profile sets rejectSimulatedEvidence; a mock vendor is refused.
    evidence: { ...reasonBaseEvidence, hardwareVendor: "mock-macos" },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "kind-not-allowed",
    evidence: { ...reasonBaseEvidence, kind: "sev-snp" },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "provider-not-allowed",
    evidence: { ...reasonBaseEvidence, provider: "rogue-kms" },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "measurement-mismatch",
    evidence: {
      ...reasonBaseEvidence,
      measurements: { ...reasonBaseEvidence.measurements, agent: ZERO_DIGEST },
    },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "measurement-revoked",
    evidence: reasonBaseEvidence,
    policy: mergeTeeRevocationsIntoPolicy(reasonBasePolicy, {
      schemaVersion: 1,
      revokedMeasurements: { agent: [GOLDEN_MEASUREMENTS.agent] },
    } satisfies TeeRevocationManifest),
    trusted: false,
  },
  {
    reason: "security-version-too-low",
    evidence: { ...reasonBaseEvidence, securityVersion: 1 },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "security-version-revoked",
    evidence: reasonBaseEvidence,
    policy: mergeTeeRevocationsIntoPolicy(reasonBasePolicy, {
      schemaVersion: 1,
      revokedSecurityVersions: [9],
    } satisfies TeeRevocationManifest),
    trusted: false,
  },
  {
    reason: "missing-nonce",
    evidence: {
      ...reasonBaseEvidence,
      freshness: { timestamp: FRESH_TIMESTAMP, verifier: "intel-pcs" },
    },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "nonce-mismatch",
    evidence: {
      ...reasonBaseEvidence,
      freshness: { ...reasonBaseEvidence.freshness, nonce: "stale-nonce" },
    },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "missing-timestamp",
    evidence: {
      ...reasonBaseEvidence,
      freshness: { nonce: ISSUED_NONCE, verifier: "intel-pcs" },
    },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "timestamp-invalid",
    evidence: {
      ...reasonBaseEvidence,
      freshness: { ...reasonBaseEvidence.freshness, timestamp: "not-a-date" },
    },
    policy: reasonBasePolicy,
    trusted: false,
  },
  {
    reason: "timestamp-stale",
    evidence: reasonBaseEvidence,
    // Advance the clock 10 min past the 5-min production freshness floor.
    policy: { ...reasonBasePolicy, nowMs: NOW + 10 * 60_000 },
    trusted: false,
  },
  {
    reason: "claim-mismatch",
    evidence: {
      ...reasonBaseEvidence,
      claims: { ...reasonBaseEvidence.claims, gpuProtected: false },
    },
    policy: reasonBasePolicy,
    trusted: false,
  },
];

const ALL_REASONS: TeeEvidencePolicyDecision["reason"][] = [
  "no-policy",
  "not-required",
  "allowed",
  "missing-evidence",
  "invalid-evidence",
  "simulated-evidence-rejected",
  "kind-not-allowed",
  "provider-not-allowed",
  "measurement-mismatch",
  "measurement-revoked",
  "security-version-too-low",
  "security-version-revoked",
  "missing-nonce",
  "nonce-mismatch",
  "missing-timestamp",
  "timestamp-invalid",
  "timestamp-stale",
  "claim-mismatch",
];

type ReasonResult = {
  reason: TeeEvidencePolicyDecision["reason"];
  expectedTrusted: boolean;
  decision: ReturnType<typeof summarize>;
  ok: boolean;
};

function runReasonMatrix(): { results: ReasonResult[]; coverageOk: boolean } {
  const results = reasonVectors.map((vector) => {
    const decision = evaluateTeeEvidencePolicy(vector.evidence, vector.policy);
    return {
      reason: vector.reason,
      expectedTrusted: vector.trusted,
      decision: summarize(decision),
      ok:
        decision.reason === vector.reason &&
        decision.trusted === vector.trusted,
    };
  });
  const covered = new Set(reasonVectors.map((vector) => vector.reason));
  const coverageOk =
    covered.size === ALL_REASONS.length &&
    ALL_REASONS.every((reason) => covered.has(reason));
  return { results, coverageOk };
}

// ---------------------------------------------------------------------------
// Confidential-inference unseal (plan §2.2 steps 4–7) against the mock KMS.
// Seal a weights blob at rest, release model-key gated on the local-only
// policy + modelWeights digest, decrypt in memory; assert the happy path
// recovers the plaintext and the tampered path is denied.
// ---------------------------------------------------------------------------

const UNSEAL_REQUIRED: readonly TeeMeasurementName[] = [
  "agent",
  "policy",
  "container",
  "os",
  "npuFirmware",
  "modelWeights",
];

async function runUnseal(): Promise<{
  happyPath: boolean;
  deniedPath: boolean;
  weightsSha256: string;
}> {
  const plaintextWeights = Buffer.from("eliza-1 full-stack weights fixture\n");
  const weightsSha256 = createHash("sha256")
    .update(plaintextWeights)
    .digest("hex");
  const modelKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", modelKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextWeights),
    cipher.final(),
  ]);
  const sealedWeights: SealedWeightsBlob = {
    algorithm: "aes-256-gcm",
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    weightsSha256,
  };

  const local = buildLocalOnly();
  const modelKeyEvidence: TeeEvidence = {
    ...local.evidence,
    measurements: {
      ...local.evidence.measurements,
      modelWeights: `sha256:${weightsSha256}`,
    },
  };
  const unsealPolicy: TeeEvidencePolicy = {
    ...local.policy,
    requiredMeasurements: {
      ...(local.policy.requiredMeasurements ?? {}),
      modelWeights: `sha256:${weightsSha256}`,
    },
  };

  const unseal = await unsealModelWeights({
    keyReleaseClient: {
      releaseKey: async (req) => {
        const decision = evaluateTeeEvidencePolicy(
          modelKeyEvidence,
          req.policy,
        );
        return {
          keyId: req.keyId,
          keyMaterialHex: decision.trusted ? modelKey.toString("hex") : "",
          decision,
        };
      },
    },
    policy: unsealPolicy,
    sealedWeights,
    requiredMeasurements: UNSEAL_REQUIRED,
    context: "full-stack-local-inference",
  });
  const happyPath =
    unseal.weights.equals(plaintextWeights) &&
    unseal.weightsSha256 === weightsSha256 &&
    unseal.decision.trusted === true;

  const deniedPath = await unsealModelWeights({
    keyReleaseClient: {
      releaseKey: async (req) => {
        const decision = evaluateTeeEvidencePolicy(
          {
            ...modelKeyEvidence,
            measurements: {
              ...modelKeyEvidence.measurements,
              agent: ZERO_DIGEST,
            },
          },
          req.policy,
        );
        return { keyId: req.keyId, keyMaterialHex: "", decision };
      },
    },
    policy: unsealPolicy,
    sealedWeights,
    requiredMeasurements: UNSEAL_REQUIRED,
  }).then(
    () => false,
    (error: unknown) =>
      error instanceof Error && /model-key release denied/.test(error.message),
  );

  return { happyPath, deniedPath, weightsSha256 };
}

// ---------------------------------------------------------------------------
// Drive everything, self-check, write artifacts.
// ---------------------------------------------------------------------------

const topologyResults = await Promise.all(topologies.map(runTopology));
const { results: reasonResults, coverageOk } = runReasonMatrix();
const unseal = await runUnseal();

const topologiesOk = topologyResults.every((result) => result.ok);
const reasonsOk = reasonResults.every((result) => result.ok);
const unsealOk = unseal.happyPath && unseal.deniedPath;

const output = {
  ok: topologiesOk && reasonsOk && coverageOk && unsealOk,
  topologies: topologyResults,
  decisionReasonMatrix: {
    coverageOk,
    reasonsCovered: reasonResults.length,
    reasonsExpected: ALL_REASONS.length,
    results: reasonResults,
  },
  modelKeyUnseal: unseal,
};

if (!output.ok) {
  const failedReasons = reasonResults.filter((result) => !result.ok);
  const failedTopologies = topologyResults.filter((result) => !result.ok);
  throw new Error(
    `TEE full-stack local failed: ${JSON.stringify(
      {
        topologiesOk,
        reasonsOk,
        coverageOk,
        unsealOk,
        failedTopologies: failedTopologies.map((result) => result.topology),
        failedReasons: failedReasons.map((result) => result.reason),
      },
      null,
      2,
    )}`,
  );
}

const outputPath = "evidence/tee/full-stack-local-2026-05-20.json";
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `TEE full-stack local passed: ${topologyResults.length} topologies, ${reasonResults.length} decision reasons, unseal OK -> ${outputPath}`,
);

function summarize(decision: TeeEvidencePolicyDecision) {
  return {
    trusted: decision.trusted,
    reason: decision.reason,
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    ...(decision.evidence === undefined
      ? {}
      : {
          evidence: {
            kind: decision.evidence.kind,
            provider: decision.evidence.provider,
            securityVersion: decision.evidence.securityVersion,
            measurements: decision.evidence.measurements,
            claims: decision.evidence.claims,
          },
        }),
  };
}
