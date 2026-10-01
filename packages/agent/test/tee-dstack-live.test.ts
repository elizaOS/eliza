/**
 * Live dstack lane: runs the real admission code against a REAL dstack guest
 * agent socket and a REAL pinned dstack-verifier. Enabled only when
 * ELIZA_DSTACK_LIVE_SOCKET, ELIZA_DSTACK_LIVE_VERIFIER,
 * ELIZA_DSTACK_LIVE_VERIFIER_CONFIG, ELIZA_DSTACK_LIVE_APP_ID,
 * ELIZA_DSTACK_LIVE_COMPOSE_HASH and ELIZA_DSTACK_LIVE_OS_IMAGE_HASH are set
 * (`bun run test:tee:dstack-live`). ELIZA_DSTACK_LIVE_EXPECT=rejected asserts
 * that the target (for example the dstack simulator) is refused instead.
 * ELIZA_DSTACK_LIVE_KMS_ROOT_PUBKEY additionally derives a state-volume key
 * through guest-v1 GetKey and verifies its chain to that pinned KMS root.
 * ELIZA_DSTACK_LIVE_GPU_COLLECTOR (path to NVIDIA `nvattest`) adds NVIDIA CC
 * GPU attestation through NRAS with the TDX request nonce; optional
 * ELIZA_DSTACK_LIVE_GPU_NRAS_URL, _GPU_JWKS_URL, _GPU_ANCHOR_SHA256 (defaults to
 * the pinned NRAS GPU intermediate), _GPU_DRIVER, _GPU_VBIOS, _GPU_HWMODEL and
 * _GPU_COUNT pin the endpoint and fleet. Admission then requires gpuProtected.
 * The release envelope is signed by an ephemeral authority generated here; the
 * lane exercises hardware appraisal, not release signing.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createConfidentialLocalAdmission } from "../src/security/confidential-local-admission.ts";
import { createDstackEvidenceProvider } from "../src/services/tee-dstack-evidence.ts";
import { DstackGuestKeyReleaseClient } from "../src/services/tee-dstack-key-release.ts";
import { mergeDstackCpuProductionProfile } from "../src/services/tee-dstack-production-profile.ts";
import { resolveDstackEvidenceConfiguration } from "../src/services/tee-dstack-release.ts";
import { NVIDIA_NRAS_GPU_INTERMEDIATE_004_SHA256 } from "../src/services/tee-gpu-nvidia.ts";
import {
  causeChain,
  signReleaseIdentity,
} from "./support/dstack-tdx-harness.ts";

const live = {
  socket: process.env.ELIZA_DSTACK_LIVE_SOCKET,
  verifier: process.env.ELIZA_DSTACK_LIVE_VERIFIER,
  verifierConfig: process.env.ELIZA_DSTACK_LIVE_VERIFIER_CONFIG,
  appId: process.env.ELIZA_DSTACK_LIVE_APP_ID,
  composeHash: process.env.ELIZA_DSTACK_LIVE_COMPOSE_HASH,
  osImageHash: process.env.ELIZA_DSTACK_LIVE_OS_IMAGE_HASH,
  kmsRoot: process.env.ELIZA_DSTACK_LIVE_KMS_ROOT_PUBKEY,
  expect: process.env.ELIZA_DSTACK_LIVE_EXPECT ?? "admitted",
  gpuCollector: process.env.ELIZA_DSTACK_LIVE_GPU_COLLECTOR,
  gpuNrasUrl: process.env.ELIZA_DSTACK_LIVE_GPU_NRAS_URL,
  gpuJwksUrl: process.env.ELIZA_DSTACK_LIVE_GPU_JWKS_URL,
  gpuAnchor: process.env.ELIZA_DSTACK_LIVE_GPU_ANCHOR_SHA256,
  gpuDriver: process.env.ELIZA_DSTACK_LIVE_GPU_DRIVER,
  gpuVbios: process.env.ELIZA_DSTACK_LIVE_GPU_VBIOS,
  gpuHwModel: process.env.ELIZA_DSTACK_LIVE_GPU_HWMODEL,
  gpuCount: process.env.ELIZA_DSTACK_LIVE_GPU_COUNT,
};
const configured = Boolean(
  live.socket &&
    live.verifier &&
    live.verifierConfig &&
    live.appId &&
    live.composeHash &&
    live.osImageHash,
);

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function liveGpuConfiguration(): Promise<
  Record<string, unknown> | undefined
> {
  if (!live.gpuCollector) return undefined;
  return {
    collector: {
      path: live.gpuCollector,
      sha256: await sha256File(live.gpuCollector),
    },
    ...(live.gpuNrasUrl ? { nrasUrl: live.gpuNrasUrl } : {}),
    jwks: {
      source: "fetched",
      ...(live.gpuJwksUrl ? { url: live.gpuJwksUrl } : {}),
      x5cTrustAnchorSha256: [
        live.gpuAnchor ?? NVIDIA_NRAS_GPU_INTERMEDIATE_004_SHA256,
      ],
    },
    timeoutMs: 120_000,
    policy: {
      ...(live.gpuDriver ? { allowedDriverVersions: [live.gpuDriver] } : {}),
      ...(live.gpuVbios ? { allowedVbiosVersions: [live.gpuVbios] } : {}),
      ...(live.gpuHwModel ? { allowedHwModels: [live.gpuHwModel] } : {}),
      ...(live.gpuCount ? { expectedGpuCount: Number(live.gpuCount) } : {}),
    },
  };
}

async function liveEnvironment(): Promise<Record<string, string>> {
  const gpu = await liveGpuConfiguration();
  const release = signReleaseIdentity({
    appId: String(live.appId),
    composeHash: String(live.composeHash),
    osImageHash: String(live.osImageHash),
  });
  return {
    ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
    ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify({
      socketPath: live.socket,
      verifierPath: live.verifier,
      verifierSha256: await sha256File(String(live.verifier)),
      verifierConfigPath: live.verifierConfig,
      verifierConfigSha256: await sha256File(String(live.verifierConfig)),
      variant: "dstack-tdx",
      ...(live.kmsRoot ? { kmsRootPublicKey: live.kmsRoot } : {}),
      ...(gpu ? { gpu } : {}),
      timeoutMs: 300_000,
    }),
    ELIZA_DSTACK_RELEASE_POLICY_JSON: release.policyJson,
    ELIZA_DSTACK_RELEASE_PUBKEY: release.publicKeyPem,
  };
}

test.skipIf(!configured)(
  "[live] dstack admission requires ELIZA_DSTACK_LIVE_SOCKET, _VERIFIER, _VERIFIER_CONFIG, _APP_ID, _COMPOSE_HASH and _OS_IMAGE_HASH",
  async () => {
    const env = await liveEnvironment();
    const outcome = await createConfidentialLocalAdmission(env).then(
      () => "admitted",
      () => "rejected",
    );
    if (outcome !== live.expect) {
      // Surface the provider-level cause; admission itself hides it by design.
      const detail = await createDstackEvidenceProvider(
        resolveDstackEvidenceConfiguration(env),
      )
        .collectEvidence()
        .then(
          (evidence) => JSON.stringify(evidence.measurements),
          (error: unknown) => causeChain(error),
        );
      throw new Error(`expected ${live.expect}, got ${outcome}: ${detail}`);
    }
    expect(outcome).toBe(live.expect);
    if (outcome !== "admitted") return;
    const config = resolveDstackEvidenceConfiguration(env);
    if (live.gpuCollector) {
      const evidence =
        await createDstackEvidenceProvider(config).collectEvidence();
      expect(evidence.claims?.gpuProtected).toBe(true);
      expect(evidence.measurements?.gpuFirmware).toMatch(/^[0-9a-f]{64}$/);
    }
    if (!live.kmsRoot) return;
    const client = new DstackGuestKeyReleaseClient({
      evidenceProvider: createDstackEvidenceProvider(config),
      socketPath: config.socketPath,
      appId: config.appId,
      kmsRootPublicKey: live.kmsRoot,
    });
    const release = await client.releaseKey({
      keyId: "state-volume",
      policy: mergeDstackCpuProductionProfile(undefined, env),
    });
    expect(release.keyMaterialHex).toMatch(/^[0-9a-f]{64}$/);
  },
  600_000,
);
