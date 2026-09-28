/**
 * CI-safe validation of the Alpha dstack deployment package: the committed
 * example renders a measured application accepted by the existing release,
 * signing and bootstrap contracts; compose keeps secrets out, pins the image
 * by digest, persists state, restarts and health-checks; and off-box
 * appraisal accepts only the signed identity through a pinned verifier.
 */
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dstackEvidenceConfiguration } from "@elizaos/agent/services/tee-dstack-evidence";
import { afterEach, describe, expect, it } from "vitest";
import {
  signAlphaProcessorPolicy,
  verifyAlphaAttestation,
} from "./alpha-dstack-attestation.ts";
import {
  alphaProcessorPolicy,
  alphaReleaseInput,
  renderAlphaApplication,
  validateAlphaSecrets,
} from "./alpha-dstack-deployment.ts";
import { signConfidentialRelease } from "./confidential-release.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "../../deploy/dstack-alpha");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
const directories: string[] = [];

async function example() {
  const deployment = JSON.parse(
    await readFile(path.join(packageDir, "deployment.example.json"), "utf8"),
  );
  // Release authority is time-bounded; keep the example currently valid.
  deployment.release = {
    notBefore: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  deployment.processors.cerebras.expiresAt = deployment.release.expiresAt;
  return deployment;
}

const IMAGE = {
  schemaVersion: 1,
  image: `ghcr.io/elizaos/eliza-alpha@sha256:${"a".repeat(64)}`,
  sourceCommit: "b".repeat(40),
  verifier: {
    image: "ghcr.io/dstack-tee/dstack-verifier:0.6.0@sha256:x",
    sha256: "c".repeat(64),
    configSha256: "d".repeat(64),
  },
};

afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Alpha dstack application", () => {
  it("renders exact bytes the release signer and bootstrap accept", async () => {
    const deployment = await example();
    const rendered = renderAlphaApplication(deployment, IMAGE, publicPem);
    expect(rendered.composeHash).toBe(
      createHash("sha256").update(rendered.appCompose).digest("hex"),
    );
    expect(rendered.appId).toBe(rendered.composeHash.slice(0, 40));
    // Same input renders identical measured bytes.
    expect(renderAlphaApplication(deployment, IMAGE, publicPem)).toEqual(
      rendered,
    );
    const envelope = signConfidentialRelease(
      alphaReleaseInput(deployment, rendered),
      privatePem,
    );
    const identity = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString(),
    );
    expect(identity).toMatchObject({
      appId: rendered.appId,
      composeHash: rendered.composeHash,
      variant: "dstack-tdx",
    });

    const manifest = JSON.parse(rendered.appCompose);
    expect(manifest.allowed_envs).toEqual(
      [
        ...rendered.secretNames,
        "ELIZA_DSTACK_LAUNCH_AUTHORIZATION_JSON",
        "ELIZA_DSTACK_RELEASE_POLICY_JSON",
      ].sort(),
    );
    expect(manifest.public_logs).toBe(false);
    const compose = JSON.parse(manifest.docker_compose_file);
    const service = compose.services["eliza-alpha"];
    expect(service.image).toBe(IMAGE.image);
    expect(service.restart).toBe("unless-stopped");
    expect(service.healthcheck.test).toContain(
      "http://127.0.0.1:2138/api/health",
    );
    expect(service.volumes).toEqual([
      "eliza-state:/data/eliza",
      "/var/run/dstack.sock:/var/run/dstack.sock",
    ]);
    expect(compose.volumes).toEqual({ "eliza-state": {} });

    const env = service.environment as Record<string, string>;
    for (const name of manifest.allowed_envs) {
      expect(env[name]).toBe(`\${${name}}`);
    }
    expect(env).toMatchObject({
      ELIZA_STATE_DIR: "/data/eliza",
      ELIZA_API_BIND: "0.0.0.0",
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
      ELIZA_PROVIDER: "cerebras",
      ELIZAOS_CLOUD_USE_INFERENCE: "false",
      ELIZAOS_CLOUD_USE_TTS: "true",
      ELIZAOS_CLOUD_USE_STT: "true",
      ELIZA_SKIP_PLUGINS: "@elizaos/plugin-local-inference",
      ELIZA_DEPLOYMENT_RUNTIME: "cloud",
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      ELIZA_DISABLE_FFI_LLAMA: "1",
      ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
      ELIZA_SCHEDULING_DEFAULT_PACKS: "alpha-routines",
    });
    expect(env.ELIZA_LOCAL_LLAMA).toBeUndefined();
    // Measured evidence config is complete except the signed release identity.
    expect(
      dstackEvidenceConfiguration
        .partial({ appId: true, composeHash: true, osImageHash: true })
        .parse(JSON.parse(env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON ?? "")),
    ).toMatchObject({ verifierSha256: "c".repeat(64), variant: "dstack-tdx" });

    // confidential-bootstrap.mjs launch contract: exact secret names, none of
    // the loader/admission prefixes it refuses.
    const launch = JSON.parse(compose.configs["alpha-launch"].content);
    expect(service.entrypoint.at(-1)).toBe("/etc/eliza-alpha/launch.json");
    expect(launch.environmentNames).toEqual(rendered.secretNames);
    expect(launch.publicKey).toBe(publicPem.trim());
    for (const name of launch.environmentNames) {
      expect(name).not.toMatch(/^(ELIZA_TEE_|ELIZA_DSTACK_|NODE_|BUN_|LD_)/);
    }
  });

  it("keeps secrets and floating images out of the measured application", async () => {
    const deployment = await example();
    expect(() =>
      renderAlphaApplication(
        { ...deployment, CEREBRAS_API_KEY: "sk-live" },
        IMAGE,
        publicPem,
      ),
    ).toThrow();
    expect(() =>
      renderAlphaApplication(
        deployment,
        { ...IMAGE, image: "ghcr.io/elizaos/eliza-alpha:latest" },
        publicPem,
      ),
    ).toThrow(/digest/);
    const secrets = {
      CEREBRAS_API_KEY: "csk-placeholder",
      ELIZAOS_CLOUD_API_KEY: "eliza-placeholder",
      ELIZA_API_TOKEN: "t".repeat(32),
      ELIZA_VAULT_PASSPHRASE: "p".repeat(32),
    };
    const rendered = renderAlphaApplication(deployment, IMAGE, publicPem);
    for (const value of Object.values(secrets)) {
      expect(rendered.appCompose).not.toContain(value);
    }
    expect(validateAlphaSecrets(deployment, secrets).map((s) => s.key)).toEqual(
      rendered.secretNames,
    );
    expect(() =>
      validateAlphaSecrets(deployment, {
        ...secrets,
        ELIZA_API_TOKEN: "short",
      }),
    ).toThrow(/32/);
    expect(() =>
      validateAlphaSecrets(deployment, { ...secrets, EXTRA: "x" }),
    ).toThrow(/exactly/);
  });

  const composeCli = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  it.runIf(composeCli.status === 0)(
    "passes docker compose config validation",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "alpha-compose-"));
      directories.push(dir);
      const manifest = JSON.parse(
        renderAlphaApplication(await example(), IMAGE, publicPem).appCompose,
      );
      const file = path.join(dir, "docker-compose.json");
      await writeFile(file, manifest.docker_compose_file);
      const env = Object.fromEntries(
        manifest.allowed_envs.map((name: string) => [name, "placeholder"]),
      );
      const result = spawnSync(
        "docker",
        ["compose", "-f", file, "config", "--quiet"],
        { encoding: "utf8", env: { ...process.env, ...env } },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});

describe("Alpha attestation appraisal", () => {
  async function setup(verifierReport: (reportData: string) => unknown) {
    const dir = await mkdtemp(path.join(tmpdir(), "alpha-attest-"));
    directories.push(dir);
    const deployment = await example();
    const reportFile = path.join(dir, "report.json");
    const verifier = path.join(dir, "dstack-verifier");
    const config = path.join(dir, "dstack-verifier.toml");
    // Stands in for the pinned verifier binary; it is pinned by digest just
    // like the real one, so the appraisal path under test is unchanged.
    await writeFile(verifier, `#!/bin/sh\ncat '${reportFile}'\n`);
    await chmod(verifier, 0o755);
    await writeFile(config, "# pinned test configuration\n");
    const digest = async (file: string) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    const image = {
      ...IMAGE,
      verifier: {
        image: IMAGE.verifier.image,
        sha256: await digest(verifier),
        configSha256: await digest(config),
      },
    };
    const rendered = renderAlphaApplication(deployment, image, publicPem);
    const release = alphaReleaseInput(deployment, rendered);
    const releaseEnvelope = signConfidentialRelease(release, privatePem);
    const processorPolicyPath = path.join(dir, "processors.envelope.json");
    await writeFile(
      processorPolicyPath,
      JSON.stringify(
        signAlphaProcessorPolicy(
          alphaProcessorPolicy(deployment, rendered, "r1"),
          privatePem,
        ),
      ),
    );
    const inputs = {
      deployment,
      image,
      release,
      releaseEnvelope,
      authorityPublicKeyPem: publicPem,
      processorPolicyPath,
      verifierPath: verifier,
      verifierConfigPath: config,
    };
    const requestEvidence = async (nonce: string) => {
      const { dstackOperatorReportData } = await import(
        "@elizaos/agent/api/tee-attestation-routes"
      );
      const reportData = dstackOperatorReportData(nonce);
      await writeFile(reportFile, JSON.stringify(verifierReport(reportData)));
      return { nonce, reportData, attestation: "abcd" };
    };
    return { inputs, rendered, deployment, requestEvidence };
  }
  const report = (
    reportData: string,
    app: { appId: string; composeHash: string; osImageHash: string },
  ) => ({
    is_valid: true,
    details: {
      quote_verified: true,
      event_log_verified: true,
      os_image_hash_verified: true,
      tee_variant: "dstack-tdx",
      report_data: reportData.padEnd(128, "0"),
      tcb_status: "UpToDate",
      advisory_ids: [],
      os_image_is_dev: false,
      acpi_tables_verified: true,
      app_info: {
        app_id: app.appId,
        compose_hash: app.composeHash,
        os_image_hash: app.osImageHash,
        mr_aggregated: "e".repeat(64),
      },
    },
  });

  it("accepts only the signed identity with an approved processor", async () => {
    let expected = { appId: "", composeHash: "", osImageHash: "" };
    const { inputs, rendered, deployment, requestEvidence } = await setup(
      (reportData) => report(reportData, expected),
    );
    expected = {
      appId: rendered.appId,
      composeHash: rendered.composeHash,
      osImageHash: deployment.osImageHash,
    };
    const result = await verifyAlphaAttestation(inputs, requestEvidence);
    expect(result).toMatchObject({
      appId: rendered.appId,
      measurements: { compose: rendered.composeHash },
      approvedRoutes: ["https://api.cerebras.ai/v1"],
    });

    // A different (e.g. rolled-back or tampered) compose is rejected.
    expected = { ...expected, composeHash: "f".repeat(64) };
    await expect(
      verifyAlphaAttestation(inputs, requestEvidence),
    ).rejects.toMatchObject({ code: "TEE_DSTACK_EVIDENCE_REJECTED" });
  });

  it("rejects replayed challenges and unsigned processor approval", async () => {
    const { inputs, rendered, deployment, requestEvidence } = await setup(
      (reportData) =>
        report(reportData, {
          appId: rendered.appId,
          composeHash: rendered.composeHash,
          osImageHash: deployment.osImageHash,
        }),
    );
    await expect(
      verifyAlphaAttestation(inputs, async (nonce) => ({
        ...(await requestEvidence(nonce)),
        reportData: "0".repeat(64),
      })),
    ).rejects.toMatchObject({ code: "ALPHA_ATTESTATION_CHALLENGE_MISMATCH" });

    const forged = JSON.parse(
      await readFile(inputs.processorPolicyPath, "utf8"),
    );
    forged.payload = forged.payload.replace('"region":"us"', '"region":"eu"');
    await writeFile(inputs.processorPolicyPath, JSON.stringify(forged));
    await expect(
      verifyAlphaAttestation(inputs, requestEvidence),
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_HOST_POLICY_REJECTED" });
  });
});
