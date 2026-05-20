import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TeeEvidence } from "../src/services/tee-evidence.ts";
import { HttpTeeKeyReleaseClient } from "../src/services/tee-key-release.ts";
import { evaluateTeeEvidencePolicy } from "../src/services/tee-policy.ts";
import { teePolicyFromReleaseManifest } from "../src/services/tee-release-policy.ts";
import { resolveTeeRuntimePolicy } from "../src/services/tee-runtime-config.ts";

const nonce = "full-stack-local-nonce";
const timestamp = "2026-05-20T00:00:00.000Z";
const tmp = await mkdtemp(path.join(tmpdir(), "eliza-tee-full-stack-"));
const inputDir = path.join(tmp, "inputs");
await mkdir(inputDir, { recursive: true });

const inputs = {
  boot: path.join(inputDir, "boot.bin"),
  os: path.join(inputDir, "os.img"),
  agent: path.join(inputDir, "agent.tar"),
  policy: path.join(inputDir, "policy.json"),
  container: path.join(inputDir, "compose.json"),
  npuFirmware: path.join(inputDir, "npu-fw.bin"),
};
for (const [name, filePath] of Object.entries(inputs)) {
  await writeFile(filePath, `full stack tee fixture ${name}\n`);
}

const measurements = Object.fromEntries(
  await Promise.all(
    Object.entries(inputs).map(async ([name, filePath]) => [
      name,
      `sha256:${createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex")}`,
    ]),
  ),
);
const releaseManifest = {
  tee: {
    enabled: true,
    providers: ["dstack", "cove"],
    measurements,
    requiredClaims: {
      debugDisabled: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      npuProtected: true,
    },
    minSecurityVersion: 1,
  },
};
const releaseManifestPath = path.join(tmp, "release-manifest.json");
await writeFile(
  releaseManifestPath,
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);

const policy = teePolicyFromReleaseManifest(releaseManifest, {
  expectedNonce: nonce,
  maxAgeMs: 60_000,
  nowMs: Date.parse(timestamp),
});
const runtimePolicy = await resolveTeeRuntimePolicy({
  nowMs: Date.parse(timestamp),
  env: {
    ELIZA_TEE_RELEASE_MANIFEST_PATH: releaseManifestPath,
    ELIZA_TEE_EXPECTED_NONCE: nonce,
    ELIZA_TEE_MAX_AGE_MS: "60000",
  },
});

const evidence: TeeEvidence = {
  kind: "dstack",
  provider: "dstack",
  hardwareVendor: "mock-macos",
  platformVersion: "full-stack-local",
  securityVersion: 1,
  measurements,
  freshness: { nonce, timestamp, verifier: "full-stack-local" },
  claims: {
    debugDisabled: true,
    secureBoot: true,
    memoryEncrypted: true,
    ioProtected: true,
    npuProtected: true,
  },
};

const accepted = evaluateTeeEvidencePolicy(evidence, policy);
const runtimeAccepted = evaluateTeeEvidencePolicy(evidence, runtimePolicy);
const rejected = evaluateTeeEvidencePolicy(
  {
    ...evidence,
    measurements: { ...measurements, agent: `sha256:${"0".repeat(64)}` },
  },
  policy,
);
const revoked = evaluateTeeEvidencePolicy(evidence, {
  ...policy,
  revokedMeasurements: {
    agent: [measurements.agent ?? ""],
  },
});

const keyRelease = await new HttpTeeKeyReleaseClient({
  baseUrl: "https://kms.example.test",
  fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      keyId: string;
      evidence: TeeEvidence;
      policy: typeof policy;
    };
    const decision = evaluateTeeEvidencePolicy(body.evidence, body.policy);
    if (!decision.trusted) {
      return Response.json({ decision }, { status: 403 });
    }
    return Response.json({
      keyId: body.keyId,
      keyMaterialHex: createHash("sha256")
        .update("full-stack-local-kms")
        .update(body.keyId)
        .update(body.evidence.measurements?.agent ?? "")
        .update(body.evidence.measurements?.policy ?? "")
        .digest("hex"),
      decision,
    });
  },
  evidenceProvider: {
    id: "full-stack-local",
    collectEvidence: async () => evidence,
  },
}).releaseKey({
  keyId: "full-stack-agent-session",
  context: "full-stack-local",
  policy,
});

const chipEvidence = JSON.parse(
  await readFile(
    "packages/chip/docs/spec-db/tee-attestation-evidence.example.json",
    "utf8",
  ),
) as TeeEvidence;
const chipEvidenceDecision = evaluateTeeEvidencePolicy(chipEvidence, {
  required: true,
  allowedKinds: ["cove"],
  requiredMeasurements: {
    agent: chipEvidence.measurements?.agent ?? "",
    policy: chipEvidence.measurements?.policy ?? "",
    device: chipEvidence.measurements?.device ?? "",
  },
  requiredClaims: {
    debugDisabled: true,
    secureBoot: true,
    memoryEncrypted: true,
    ioProtected: true,
    npuProtected: true,
  },
});

const output = {
  ok:
    accepted.trusted &&
    runtimeAccepted.trusted &&
    !rejected.trusted &&
    !revoked.trusted &&
    /^[a-f0-9]{64}$/.test(keyRelease.keyMaterialHex) &&
    chipEvidenceDecision.trusted,
  releaseManifestPath,
  accepted: summarize(accepted),
  runtimeAccepted: summarize(runtimeAccepted),
  rejected: summarize(rejected),
  revoked: summarize(revoked),
  keyRelease: {
    keyId: keyRelease.keyId,
    keyMaterialSha256: createHash("sha256")
      .update(keyRelease.keyMaterialHex)
      .digest("hex"),
    decision: summarize(keyRelease.decision),
  },
  chipEvidenceDecision: summarize(chipEvidenceDecision),
};
if (!output.ok) {
  throw new Error(`TEE full-stack local failed: ${JSON.stringify(output)}`);
}

const outputPath = "evidence/tee/full-stack-local-2026-05-20.json";
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`TEE full-stack local passed: ${outputPath}`);

function summarize(decision: {
  trusted: boolean;
  reason: string;
  detail?: string;
  evidence?: TeeEvidence;
}) {
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
