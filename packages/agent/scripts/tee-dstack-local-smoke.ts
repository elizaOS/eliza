/**
 * tee-dstack-local-smoke.ts — LOCAL dstack dev-mode end-to-end smoke.
 *
 * WHAT THIS PROVES (and what it does NOT):
 *   This script stands up a local HTTP endpoint on 127.0.0.1 that emulates the
 *   dstack guest-agent (tappd) contract — a `GetQuote`-style RPC that binds a
 *   caller-supplied `report_data` into the returned quote, plus the normalized
 *   `TeeEvidence` document the in-domain attestation agent would assemble from
 *   that quote. The dstack provider is pointed at it via ELIZA_TEE_EVIDENCE_URL.
 *
 *   It then exercises the FULL confidential-AI plumbing without any TDX
 *   hardware:
 *     - DEV lane: a permissive dev policy ALLOWS the (simulated, devmode)
 *       evidence, a key releases over both the local KDF client and the HTTP
 *       (RA-TLS-shaped) client with wrapTeeReleaseKey, and a small sealed
 *       weights blob unseals in memory. End-to-end plumbing works locally.
 *     - PRODUCTION lane: the production profile (teeProductionProfile /
 *       mergeTeeProductionProfile, rejectSimulatedEvidence) REJECTS the SAME
 *       simulated evidence, and model-key unseal under it FAILS — the
 *       ciphertext stays sealed.
 *
 *   This is DEV-ONLY. It proves the PLUMBING, not hardware trust. The evidence
 *   it serves is SIMULATED (kind "dstack", hardwareVendor "mock-devmode",
 *   verifier "local-dstack-sim", quote marked "...-devmode-simulated"); there is
 *   NO TDX/CoVE quote-signature verification anywhere in this path. Real quote
 *   verification (Intel PCS/QvL, RTMRs, report_data binding, RA-TLS cert chain)
 *   is plan Phase B2 and is BLOCKED on a TDX host. Until B2 lands the system
 *   must not claim hardware-verified trust — and the production lane below
 *   demonstrates that it refuses to.
 *
 * REAL dstack BINARY: none is available on this host (`which dstack` fails; no
 * dstack repo/simulator under the tree). This file IS the faithful local
 * simulator. If a real dstack guest-agent / simulator socket becomes available
 * (DSTACK_TAPPD_URL), the dstack provider already prefers it; this script only
 * supplies the local stand-in.
 *
 * Run:  bun packages/agent/scripts/tee-dstack-local-smoke.ts
 * Exit: 0 with a PASS summary; non-zero on any unexpected outcome.
 */
import { type BinaryLike, createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { collectDstackTeeEvidence } from "../src/services/dstack-tee-provider.ts";
import {
  MODEL_KEY_ID,
  type SealedWeightsBlob,
  sealModelWeightsShards,
  unsealModelWeights,
} from "../src/services/tee-confidential-inference.ts";
import type { TeeEvidence } from "../src/services/tee-evidence.ts";
import {
  HttpTeeKeyReleaseClient,
  LocalTeeKeyReleaseClient,
  type TeeKeyReleaseRequest,
  wrapTeeReleaseKey,
} from "../src/services/tee-key-release.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "../src/services/tee-policy.ts";
import { mergeTeeProductionProfile } from "../src/services/tee-production-profile.ts";

// ---------------------------------------------------------------------------
// Simulated devmode evidence (the dstack guest-agent / tappd would emit this).
// The non-production markers are deliberate and load-bearing for the prod lane:
// hardwareVendor "mock-devmode", verifier "local-dstack-sim", and a quote string
// tagged "devmode-simulated" all trip rejectSimulatedEvidence in production.
// ---------------------------------------------------------------------------
const sha256Hex = (input: BinaryLike): string =>
  createHash("sha256").update(input).digest("hex");

const measurementDigest = (label: string): string =>
  `sha256:${sha256Hex(`local-dstack-sim:${label}`)}`;

const NONCE_HEX = randomBytes(32).toString("hex");
const TIMESTAMP = new Date().toISOString();

const AGENT_DIGEST = measurementDigest("agent");
const POLICY_DIGEST = measurementDigest("policy");
const CONTAINER_DIGEST = measurementDigest("container");
const OS_DIGEST = measurementDigest("os");
const BOOT_DIGEST = measurementDigest("boot");
const DEVICE_DIGEST = measurementDigest("device");
const NPU_FIRMWARE_DIGEST = measurementDigest("npuFirmware");

// The sealed weights blob (small) is sealed below; its plaintext digest is used
// to bind model-key release to the expected weights (modelWeights measurement).
const PLAINTEXT_WEIGHTS = Buffer.from(
  "eliza-1 dev-mode sealed weights blob — local plumbing proof only",
  "utf8",
);
const WEIGHTS_SHA256 = sha256Hex(PLAINTEXT_WEIGHTS);

type SimulatedEvidence = TeeEvidence & {
  kind: "dstack";
  measurements: Record<string, string>;
  freshness: { nonce: string; timestamp: string; verifier: string };
};

function buildSimulatedEvidence(
  reportDataHex: string,
  nonceHex: string,
): SimulatedEvidence {
  return {
    kind: "dstack",
    provider: "dstack",
    hardwareVendor: "mock-devmode",
    platformVersion: "dstack-local-sim-0",
    securityVersion: 3,
    measurements: {
      boot: BOOT_DIGEST,
      os: OS_DIGEST,
      agent: AGENT_DIGEST,
      policy: POLICY_DIGEST,
      container: CONTAINER_DIGEST,
      device: DEVICE_DIGEST,
      npuFirmware: NPU_FIRMWARE_DIGEST,
      modelWeights: `sha256:${WEIGHTS_SHA256}`,
    },
    freshness: {
      nonce: nonceHex,
      timestamp: TIMESTAMP,
      verifier: "local-dstack-sim",
    },
    claims: {
      debugDisabled: true,
      productionLifecycle: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      npuProtected: true,
    },
    // A genuine tappd quote is an Intel TDX quote blob; here it is an explicit
    // devmode-simulated marker so production rejection has something to catch
    // and so nothing downstream can mistake it for a real quote.
    quote: `dstack-devmode-simulated:${reportDataHex.slice(0, 16)}`,
    reportData: reportDataHex,
  };
}

// ---------------------------------------------------------------------------
// Local dstack guest-agent (tappd) simulator: a GetQuote-style endpoint that
// binds report_data, an evidence endpoint the dstack provider reads, and a KMS
// key-release endpoint that wraps the key to the agent's ephemeral epk.
// ---------------------------------------------------------------------------
type KeyReleasePayload = {
  keyId: string;
  context?: string;
  nonce: string;
  ephemeralPublicKey: string;
  reportData?: string;
  policy: TeeEvidencePolicy;
  evidence: TeeEvidence;
};

function defaultReportData(): string {
  // report_data = SHA256(nonce || 0). When a client (HttpTeeKeyReleaseClient)
  // re-collects with its own binding, the evidence endpoint echoes the supplied
  // report_data instead (see handler below).
  return sha256Hex(Buffer.from(NONCE_HEX, "hex"));
}

function startSimulator(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    void routeRequest(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("dstack simulator did not bind to a TCP port."));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  // tappd GetQuote-style: bind a caller-supplied report_data + nonce into the
  // returned quote and emit the normalized evidence document for it. A bare
  // /evidence collect (no params) gets the static device nonce.
  if (url.pathname === "/prpc/Tappd.GetQuote" || url.pathname === "/evidence") {
    const reportData =
      url.searchParams.get("report_data") ?? defaultReportData();
    const nonce = url.searchParams.get("nonce") ?? NONCE_HEX;
    respondJson(response, 200, buildSimulatedEvidence(reportData, nonce));
    return;
  }

  if (url.pathname === "/v1/tee/key-release" && request.method === "POST") {
    await handleKeyRelease(request, response);
    return;
  }

  respondJson(response, 404, { error: "not-found", path: url.pathname });
}

async function handleKeyRelease(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const payload = JSON.parse(await readBody(request)) as KeyReleasePayload;
  const decision = evaluateTeeEvidencePolicy(payload.evidence, payload.policy);
  if (!decision.trusted) {
    respondJson(response, 403, { decision });
    return;
  }
  // Deterministic per-app key bound to the measured identity (models the dstack
  // KMS deriving an app key from compose/agent/policy measurements).
  const keyMaterialHex = sha256Hex(
    Buffer.concat([
      Buffer.from("local-dstack-sim-kms\n", "utf8"),
      Buffer.from(payload.keyId, "utf8"),
      Buffer.from(payload.context ?? "", "utf8"),
      Buffer.from(payload.evidence.measurements?.agent ?? "", "utf8"),
      Buffer.from(payload.evidence.measurements?.policy ?? "", "utf8"),
    ]),
  );
  const wrappedKey = wrapTeeReleaseKey({
    keyMaterialHex,
    agentEphemeralPublicKeyDerBase64: payload.ephemeralPublicKey,
    nonceHex: payload.nonce,
  });
  respondJson(response, 200, {
    keyId: payload.keyId,
    wrappedKey,
    nonce: payload.nonce,
    decision,
  });
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Self-checking assertions.
// ---------------------------------------------------------------------------
class SmokeFailure extends Error {}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

const isHex32Bytes = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

function summarizeDecision(decision: TeeEvidencePolicyDecision): {
  trusted: boolean;
  reason: TeeEvidencePolicyDecision["reason"];
  detail?: string;
} {
  return {
    trusted: decision.trusted,
    reason: decision.reason,
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const { server, baseUrl } = await startSimulator();
const endpointUrl = `${baseUrl}/evidence`;

try {
  // Collect SIMULATED evidence through the real dstack provider, pointed at the
  // local tappd-style endpoint via ELIZA_TEE_EVIDENCE_URL semantics.
  const evidence = await collectDstackTeeEvidence({ endpointUrl, env: {} });
  assert(evidence.kind === "dstack", "collected evidence must be kind dstack");
  assert(
    evidence.hardwareVendor === "mock-devmode",
    "collected evidence must carry the devmode marker",
  );

  // === DEV LANE =========================================================
  // A permissive dev policy that matches the measured identity but does NOT
  // reject simulated evidence. This is what local development uses.
  const devPolicy: TeeEvidencePolicy = {
    required: true,
    allowedKinds: ["dstack"],
    allowedProviders: ["dstack"],
    minSecurityVersion: 1,
    expectedNonce: NONCE_HEX,
    maxAgeMs: 300_000,
    nowMs: Date.parse(TIMESTAMP),
    requiredMeasurements: {
      boot: BOOT_DIGEST,
      os: OS_DIGEST,
      agent: AGENT_DIGEST,
      policy: POLICY_DIGEST,
      container: CONTAINER_DIGEST,
      device: DEVICE_DIGEST,
      npuFirmware: NPU_FIRMWARE_DIGEST,
      modelWeights: `sha256:${WEIGHTS_SHA256}`,
    },
    requiredClaims: {
      debugDisabled: true,
      productionLifecycle: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      npuProtected: true,
    },
  };

  const devDecision = evaluateTeeEvidencePolicy(evidence, devPolicy);
  assert(
    devDecision.trusted && devDecision.reason === "allowed",
    `dev policy must ALLOW simulated evidence, got: ${JSON.stringify(summarizeDecision(devDecision))}`,
  );

  // Local KDF key-release (LocalTeeKeyReleaseClient).
  const localClient = new LocalTeeKeyReleaseClient({
    masterSecretHex: "33".repeat(32),
    evidenceProvider: {
      id: "local-dstack-sim",
      collectEvidence: async () => evidence,
    },
  });
  const localRelease = await localClient.releaseKey({
    keyId: "agent-session",
    context: "tee-dstack-local-smoke",
    policy: devPolicy,
  });
  assert(
    localRelease.decision.trusted && isHex32Bytes(localRelease.keyMaterialHex),
    "local KDF client must release a 32-byte key under the dev policy",
  );

  // HTTP (RA-TLS-shaped) key-release with nonce/epk binding + wrapTeeReleaseKey.
  // The provider re-collects evidence bound to the client's report_data; the
  // simulator echoes it via the evidence endpoint, so report_data matches.
  const httpClient = new HttpTeeKeyReleaseClient({
    baseUrl,
    evidenceProvider: {
      id: "local-dstack-sim",
      collectEvidence: async () => evidence,
      collectEvidenceWithReportData: async (challenge) =>
        collectDstackTeeEvidence({
          endpointUrl: `${baseUrl}/prpc/Tappd.GetQuote?report_data=${challenge.reportDataHex}&nonce=${challenge.nonce}`,
          env: {},
        }),
    },
  });
  const httpReleaseRequest: TeeKeyReleaseRequest = {
    keyId: "remote-signing",
    context: "tee-dstack-local-smoke-http",
    // expectedNonce is overwritten by the client with its fresh binding nonce;
    // drop it here so the client's report_data binding governs freshness.
    policy: { ...devPolicy, expectedNonce: undefined },
  };
  const httpRelease = await httpClient.releaseKey(httpReleaseRequest);
  assert(
    httpRelease.decision.trusted && isHex32Bytes(httpRelease.keyMaterialHex),
    "HTTP client must release a 32-byte wrapped key under the dev policy",
  );

  // Confidential-inference unseal: the blob must be sealed with the SAME key the
  // unseal path releases. unsealModelWeights releases keyId="model-key" with
  // context "tee-dstack-local-smoke", so seal with exactly that released key.
  const modelKeyRelease = await localClient.releaseKey({
    keyId: MODEL_KEY_ID,
    context: "tee-dstack-local-smoke",
    policy: devPolicy,
  });
  assert(
    isHex32Bytes(modelKeyRelease.keyMaterialHex),
    "local KDF client must release a 32-byte model-key under the dev policy",
  );
  const sealKey = Buffer.from(modelKeyRelease.keyMaterialHex, "hex");
  const manifest = sealModelWeightsShards({
    weights: PLAINTEXT_WEIGHTS,
    key: sealKey,
    shardSizeBytes: PLAINTEXT_WEIGHTS.length,
  });
  sealKey.fill(0);
  // Single-shard manifest collapses to the single-blob envelope shape.
  const onlyShard = manifest.shards[0];
  assert(onlyShard !== undefined, "sealed manifest must have a shard");
  const sealedBlob: SealedWeightsBlob = {
    algorithm: "aes-256-gcm",
    ivBase64: onlyShard.ivBase64,
    authTagBase64: onlyShard.authTagBase64,
    ciphertextBase64: onlyShard.ciphertextBase64,
    weightsSha256: manifest.weightsSha256,
  };
  assert(
    manifest.weightsSha256 === WEIGHTS_SHA256,
    "sealed manifest digest must match the modelWeights binding",
  );

  const requiredUnsealMeasurements = [
    "agent",
    "policy",
    "container",
    "os",
    "npuFirmware",
    "modelWeights",
  ] as const;
  const unsealed = await unsealModelWeights({
    keyReleaseClient: localClient,
    policy: devPolicy,
    sealedWeights: sealedBlob,
    requiredMeasurements: requiredUnsealMeasurements,
    context: "tee-dstack-local-smoke",
  });
  assert(
    unsealed.weights.equals(PLAINTEXT_WEIGHTS) &&
      unsealed.weightsSha256 === WEIGHTS_SHA256,
    "dev unseal must recover the exact plaintext weights",
  );
  unsealed.weights.fill(0);

  // === PRODUCTION LANE ==================================================
  // Apply the production profile to the SAME dev policy + SAME simulated
  // evidence. rejectSimulatedEvidence must fire on the devmode markers.
  const prodPolicy = mergeTeeProductionProfile(devPolicy, {
    inference: "local",
  });
  assert(
    prodPolicy.rejectSimulatedEvidence === true && prodPolicy.required === true,
    "production profile must force rejectSimulatedEvidence + required",
  );

  const prodDecision = evaluateTeeEvidencePolicy(evidence, prodPolicy);
  assert(
    !prodDecision.trusted &&
      prodDecision.reason === "simulated-evidence-rejected",
    `production profile must REJECT simulated evidence, got: ${JSON.stringify(summarizeDecision(prodDecision))}`,
  );

  // The unseal under the production profile must FAIL — ciphertext stays sealed.
  let prodUnsealError: string | undefined;
  try {
    await unsealModelWeights({
      keyReleaseClient: localClient,
      policy: prodPolicy,
      sealedWeights: sealedBlob,
      requiredMeasurements: requiredUnsealMeasurements,
      context: "tee-dstack-local-smoke-prod",
    });
  } catch (error) {
    prodUnsealError = error instanceof Error ? error.message : String(error);
  }
  assert(
    prodUnsealError !== undefined,
    "model-key unseal MUST fail under the production profile (ciphertext stays sealed)",
  );

  // === PASS SUMMARY =====================================================
  const summary = {
    ok: true,
    realDstackBinaryFound: false,
    simulator: { kind: "local-tappd-getquote-emulator", endpoint: endpointUrl },
    dev: {
      decision: summarizeDecision(devDecision),
      localKeyRelease: { keyId: localRelease.keyId, released: true },
      httpKeyRelease: { keyId: httpRelease.keyId, released: true },
      weightsUnsealed: true,
      weightsSha256: WEIGHTS_SHA256,
    },
    production: {
      decision: summarizeDecision(prodDecision),
      unsealRejected: true,
      unsealError: prodUnsealError,
    },
  };
  console.log("PASS — dstack local dev-mode smoke");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "DEV-ONLY: this proves the confidential-AI PLUMBING, not hardware trust. " +
      "Real TDX quote verification is Phase B2 and is BLOCKED on a TDX host.",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL — dstack local dev-mode smoke: ${message}`);
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
