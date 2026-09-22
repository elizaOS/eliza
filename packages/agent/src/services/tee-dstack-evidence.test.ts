/**
 * Exercises real Unix-socket and subprocess evidence transport with an explicitly
 * synthetic verifier executable. Tests prove admission and lifecycle contracts,
 * not hardware quote cryptography, which belongs to pinned dstack-verifier.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateTeeBootGate } from "./tee-boot-gate.ts";
import {
  createDstackEvidenceProvider,
  type DstackEvidenceConfig,
} from "./tee-dstack-evidence.ts";
import { resolveTeeEvidenceProvider } from "./tee-evidence-provider.ts";

const challenge = { nonce: "ab".repeat(32), reportDataHex: "cd".repeat(32) };
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let dir: string;
let server: Server;
let config: DstackEvidenceConfig;
let override: Record<string, unknown>;
let inputPath: string | undefined;
let guestMode: "normal" | "http-error" | "invalid";
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
    timeoutMs: 5000,
  };
  server = createServer(async (req, res) => {
    expect(req.url).toBe("/v1/Attest");
    expect(req.method).toBe("POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
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
        ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
        ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config),
      };
      const evidenceProvider = createDstackEvidenceProvider(config);
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
      ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
      ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(config),
      ELIZA_TEE_POLICY_JSON: JSON.stringify({
        requiredClaims: { gpuProtected: true },
      }),
    };
    const evidenceProvider = createDstackEvidenceProvider(config);
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
  it("CPU profile rejects a normalized JSON provider even when its id resembles the adapter", async () => {
    const env = {
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
  it("kills timed-out verification and removes temporary evidence", async () => {
    config.timeoutMs = 2000;
    scriptMode = "hang";
    await expect(collect()).rejects.toThrow(/appraisal failed/);
    await expectTempCleanup();
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);
  it("kills an in-flight verifier on cancellation and cleans its evidence", async () => {
    scriptMode = "hang";
    const abort = new AbortController();
    const collecting = createDstackEvidenceProvider(
      config,
    ).collectEvidenceWithReportData(challenge, abort.signal);
    const rejected = expect(collecting).rejects.toThrow(/appraisal failed/);
    await expect
      .poll(async () => {
        try {
          return Number(await readFile(join(dir, "pid"), "utf8"));
        } catch (error) {
          // error-policy:J4 Startup has an explicit pending state until the fixture writes its pid.
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      })
      .toBeDefined();
    abort.abort();
    await rejected;
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
