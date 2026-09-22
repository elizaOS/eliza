/**
 * Exercises real Unix-socket and subprocess evidence transport with an explicitly
 * synthetic verifier executable. Tests prove admission and lifecycle contracts,
 * not hardware quote cryptography, which belongs to pinned dstack-verifier.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateTeeBootGate } from "./tee-boot-gate.ts";
import {
  createDstackEvidenceProvider,
  type DstackEvidenceConfig,
} from "./tee-dstack-evidence.ts";
import {
  DSTACK_RELEASE_SIGNATURE_DOMAIN,
  resolveDstackEvidenceConfiguration,
} from "./tee-dstack-release.ts";
import { resolveTeeEvidenceProvider } from "./tee-evidence-provider.ts";

const challenge = { nonce: "ab".repeat(32), reportDataHex: "cd".repeat(32) };
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let dir: string;
let server: Server;
let config: DstackEvidenceConfig;
let override: Record<string, unknown>;
let inputPath: string | undefined;
let guestMode: "normal" | "http-error" | "invalid" | "hang";
let scriptMode: "normal" | "hang" | "large" | "invalid" | "exit";

beforeEach(async () => {
  dir = await mkdtemp("/tmp/ea-");
  override = {};
  inputPath = undefined;
  scriptMode = "normal";
  guestMode = "normal";
  const script = `#!${process.execPath}
const fs = require('node:fs');
const input = process.argv[process.argv.length - 1];
const request = JSON.parse(fs.readFileSync(input, 'utf8'));
const data = JSON.parse(Buffer.from(request.attestation, 'hex').toString('utf8'));
fs.writeFileSync(${JSON.stringify(join(dir, "input-path"))}, input);
fs.writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
if (data.mode === 'hang') setInterval(() => {}, 1000);
else if (data.mode === 'large') process.stdout.write('x'.repeat(17 * 1024 * 1024));
else if (data.mode === 'invalid') process.stdout.write('not-json');
else if (data.mode === 'exit') process.exit(1);
else process.stdout.write(JSON.stringify(data.response));
`;
  await writeFile(join(dir, "verifier"), script, { mode: 0o700 });
  await chmod(join(dir, "verifier"), 0o700);
  await writeFile(join(dir, "config.toml"), "# synthetic verifier config\n");
  config = {
    socketPath: join(dir, "guest.sock"),
    verifierPath: join(dir, "verifier"),
    verifierSha256: digest(script),
    verifierConfigPath: join(dir, "config.toml"),
    verifierConfigSha256: digest("# synthetic verifier config\n"),
    appId: "11".repeat(20),
    composeHash: "22".repeat(32),
    osImageHash: "33".repeat(32),
    variant: "dstack-tdx",
    timeoutMs: 60_000,
  };
  server = createServer(async (req, res) => {
    expect(req.url).toBe("/v1/Attest");
    expect(req.method).toBe("POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (guestMode === "hang") return;
    if (guestMode !== "normal") {
      res.statusCode = guestMode === "http-error" ? 503 : 200;
      res.end("invalid guest response");
      return;
    }
    const response = {
      is_valid: true,
      details: {
        quote_verified: true,
        event_log_verified: true,
        os_image_hash_verified: true,
        tee_variant: config.variant,
        report_data: body.report_data.padEnd(128, "0"),
        tcb_status: config.variant === "dstack-tdx" ? "UpToDate" : null,
        advisory_ids: [],
        os_image_is_dev: false,
        acpi_tables_verified: true,
        app_info: {
          app_id: config.appId,
          compose_hash: config.composeHash,
          os_image_hash: config.osImageHash,
          mr_aggregated: "44".repeat(32),
          instance_id: "55".repeat(20),
        },
        ...override,
      },
    };
    res.end(
      JSON.stringify({
        attestation: Buffer.from(
          JSON.stringify({ response, mode: scriptMode }),
        ).toString("hex"),
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(config.socketPath, resolve),
  );
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(dir, { recursive: true, force: true });
});
function signedReleaseEnv() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      appId: config.appId,
      composeHash: config.composeHash,
      osImageHash: config.osImageHash,
      variant: config.variant,
      notBefore: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  );
  return {
    ELIZA_DSTACK_RELEASE_PUBKEY: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    ELIZA_DSTACK_RELEASE_POLICY_JSON: JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(DSTACK_RELEASE_SIGNATURE_DOMAIN), payload]),
        privateKey,
      ).toString("base64"),
    }),
  };
}
async function collect() {
  return createDstackEvidenceProvider(config).collectEvidenceWithReportData(
    challenge,
  );
}
async function expectTempCleanup() {
  inputPath = await readFile(join(dir, "input-path"), "utf8");
  await expect(readFile(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("dstack evidence adapter protocol", () => {
  it("binds the verified identity and fresh report data without inventing accelerator claims", async () => {
    const evidence = await collect();
    expect(evidence.reportData).toBe(challenge.reportDataHex);
    expect(evidence.freshness?.nonce).toBe(challenge.nonce);
    expect(evidence.measurements).toEqual({
      compose: config.composeHash,
      os: config.osImageHash,
      boot: "44".repeat(32),
    });
    expect(evidence.claims).toEqual({ debugDisabled: true });
    await expectTempCleanup();
  });
  it("resolves explicit deployment configuration through the boot provider seam", async () => {
    const provider = resolveTeeEvidenceProvider({
      env: { ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config) },
    });
    const evidence = await provider?.collectEvidence();
    expect(evidence?.kind).toBe("tdx");
    expect(evidence?.freshness?.nonce).toBe(evidence?.reportData);
    await expectTempCleanup();
  });
  it.each(["compose_hash", "os_image_hash"] as const)(
    "rejects mismatched verified %s",
    async (field) => {
      override = {
        app_info: {
          app_id: config.appId,
          compose_hash: config.composeHash,
          os_image_hash: config.osImageHash,
          mr_aggregated: "44".repeat(32),
          instance_id: "55".repeat(20),
          [field]: "99".repeat(32),
        },
      };
      await expect(collect()).rejects.toThrow(/appraisal failed/);
    },
  );
  it.each(["dstack-tdx", "dstack-nitro-enclave"] as const)(
    "admits verified %s through the CPU boot profile without weakening accelerator profiles",
    async (variant) => {
      config.variant = variant;
      const env = {
        ...signedReleaseEnv(),
        ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
        ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config),
      };
      const evidenceProvider = createDstackEvidenceProvider(
        resolveDstackEvidenceConfiguration(env),
      );
      const gate = await evaluateTeeBootGate({ env, evidenceProvider });
      expect(gate.required).toBe(true);
      expect(gate.productionProfile).toBe(true);
      expect(gate.secretsEnabled).toBe(true);
      const accelerator = await evaluateTeeBootGate({
        env: { ...env, ELIZA_TEE_PRODUCTION_PROFILE: "true" },
        evidenceProvider,
      });
      expect(accelerator.secretsEnabled).toBe(false);
      expect(accelerator.decision?.reason).toBe("claim-mismatch");
    },
  );
  it("CPU profile preserves stricter caller claims and refuses conflicting measurements", async () => {
    const env = {
      ...signedReleaseEnv(),
      ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
      ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config),
      ELIZA_TEE_POLICY_JSON: JSON.stringify({
        requiredClaims: { gpuProtected: true },
      }),
    };
    const evidenceProvider = createDstackEvidenceProvider(
      resolveDstackEvidenceConfiguration(env),
    );
    expect(
      (await evaluateTeeBootGate({ env, evidenceProvider })).secretsEnabled,
    ).toBe(false);
    env.ELIZA_TEE_POLICY_JSON = JSON.stringify({
      requiredMeasurements: { compose: "aa".repeat(32) },
    });
    await expect(
      evaluateTeeBootGate({ env, evidenceProvider }),
    ).rejects.toThrow(/Invalid dstack CPU/);
  });
  it("CPU profile refuses an adapter which omits the signed release lifetime", async () => {
    const env = {
      ...signedReleaseEnv(),
      ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
      ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config),
    };
    await expect(
      evaluateTeeBootGate({
        env,
        evidenceProvider: createDstackEvidenceProvider(config),
      }),
    ).rejects.toThrow(/requires the pinned dstack evidence adapter/);
  });
  it("CPU profile rejects a normalized JSON provider even when its id resembles the adapter", async () => {
    const env = {
      ...signedReleaseEnv(),
      ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
      ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config),
    };
    const evidence = await collect();
    await expect(
      evaluateTeeBootGate({
        env,
        evidenceProvider: {
          id: "dstack-guest-v1-pinned-verifier",
          collectEvidence: async () => evidence,
        },
      }),
    ).rejects.toThrow(/requires the pinned dstack evidence adapter/);
  });
  it("keeps Nitro Enclave's absent TCB distinct from Intel UpToDate", async () => {
    config.variant = "dstack-nitro-enclave";
    expect((await collect()).kind).toBe("nitro");
    override = { tcb_status: "UpToDate" };
    await expect(collect()).rejects.toThrow(/appraisal failed/);
  });
  it.each([
    { report_data: "00".repeat(64) },
    { quote_verified: false },
    { event_log_verified: false },
    { os_image_hash_verified: false },
    { os_image_is_dev: true },
    { acpi_tables_verified: false },
    { tcb_status: "OutOfDate" },
    { advisory_ids: ["INTEL-SA-test"] },
    { tee_variant: "unknown" },
    {
      app_info: {
        app_id: "99".repeat(20),
        compose_hash: "22".repeat(32),
        os_image_hash: "33".repeat(32),
        mr_aggregated: "44".repeat(32),
        instance_id: "55",
      },
    },
  ])("rejects invalid appraisal %j", async (fields) => {
    override = fields;
    await expect(collect()).rejects.toThrow(/appraisal failed/);
    await expectTempCleanup();
  });
  it.each(["verifier", "config.toml"])(
    "rejects a changed pinned %s",
    async (name) => {
      await writeFile(join(dir, name), "changed");
      await expect(collect()).rejects.toThrow(/appraisal failed/);
      await expect(readFile(join(dir, "input-path"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it.each(["invalid", "large", "exit"] as const)(
    "rejects subprocess %s and cleans temporary evidence",
    async (mode) => {
      scriptMode = mode;
      await expect(collect()).rejects.toThrow(/appraisal failed/);
      await expectTempCleanup();
    },
  );
  it("times out a guest which never returns evidence", async () => {
    config.timeoutMs = 500;
    guestMode = "hang";
    await expect(collect()).rejects.toThrow(/appraisal failed/);
    await expect(readFile(join(dir, "input-path"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("kills an in-flight verifier on cancellation and cleans its evidence", async () => {
    scriptMode = "hang";
    const abort = new AbortController();
    const collecting = createDstackEvidenceProvider(
      config,
    ).collectEvidenceWithReportData(challenge, abort.signal);
    const outcome = collecting.then(
      () => ({ ok: true, error: undefined }),
      (error: unknown) => ({ ok: false, error }),
    );
    try {
      await expect
        .poll(
          async () => {
            try {
              return Number(await readFile(join(dir, "pid"), "utf8"));
            } catch (error) {
              // error-policy:J4 Startup remains explicitly pending until the fixture writes its pid.
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return undefined;
              throw error;
            }
          },
          { timeout: 30_000 },
        )
        .toBeDefined();
    } finally {
      abort.abort();
      await outcome;
    }
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: "Dstack evidence collection/appraisal failed",
    });
    await expectTempCleanup();
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("honors cancellation before opening the guest socket", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      createDstackEvidenceProvider(config).collectEvidenceWithReportData(
        challenge,
        abort.signal,
      ),
    ).rejects.toThrow();
    await expect(readFile(join(dir, "input-path"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(["http-error", "invalid"] as const)(
    "rejects guest %s before running a verifier",
    async (mode) => {
      guestMode = mode;
      await expect(collect()).rejects.toThrow(/appraisal failed/);
      await expect(readFile(join(dir, "input-path"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("rejects an unexecutable pinned verifier without hanging", async () => {
    await chmod(config.verifierPath, 0o600);
    await expect(collect()).rejects.toThrow(/appraisal failed/);
  });
  it("rejects a non-socket endpoint", async () => {
    config.socketPath = config.verifierConfigPath;
    await expect(collect()).rejects.toThrow(/appraisal failed/);
  });
});
