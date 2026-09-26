/**
 * Collects guest-v1 dstack attestations and appraises them with a locally pinned
 * dstack-verifier. The verifier owns platform cryptography; this adapter binds
 * its result to the challenge and deployment identity. Socket, executable and
 * configuration belong inside the agent's single-tenant CVM trust boundary.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { z } from "zod";
import type { TeeEvidence, TeeEvidenceProvider } from "./tee-evidence.ts";
import type {
  TeeReportDataBoundEvidenceProvider,
  TeeReportDataChallenge,
} from "./tee-key-release.ts";

const verifiedProviders = new WeakMap<
  TeeEvidenceProvider,
  z.output<typeof dstackEvidenceConfiguration>
>();
/** Binds a concrete adapter to its complete signed deployment configuration. */
export function isDstackEvidenceProvider(
  provider: TeeEvidenceProvider,
  expected: z.output<typeof dstackEvidenceConfiguration>,
): boolean {
  const actual = verifiedProviders.get(provider);
  return (
    actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected)
  );
}

const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/i);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i);
export const dstackEvidenceConfiguration = z.object({
  socketPath: z.string().refine(isAbsolute),
  verifierPath: z.string().refine(isAbsolute),
  verifierSha256: sha256,
  verifierConfigPath: z.string().refine(isAbsolute),
  verifierConfigSha256: sha256,
  appId: hex,
  composeHash: sha256,
  osImageHash: sha256,
  variant: z.enum(["dstack-tdx", "dstack-nitro-enclave"]),
  releaseValidity: z
    .object({ notBefore: z.iso.datetime(), expiresAt: z.iso.datetime() })
    .optional(),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
});
export type DstackEvidenceConfig = z.input<typeof dstackEvidenceConfiguration>;
const responseSchema = z.object({
  is_valid: z.literal(true),
  details: z.object({
    quote_verified: z.literal(true),
    event_log_verified: z.literal(true),
    os_image_hash_verified: z.literal(true),
    tee_variant: z.enum(["dstack-tdx", "dstack-nitro-enclave"]),
    report_data: z.string().regex(/^[0-9a-f]{128}$/i),
    tcb_status: z.string().nullable(),
    advisory_ids: z.array(z.string()).length(0),
    os_image_is_dev: z.boolean().nullable(),
    acpi_tables_verified: z.boolean(),
    app_info: z.object({
      app_id: hex,
      compose_hash: sha256,
      os_image_hash: sha256,
      mr_aggregated: sha256,
    }),
  }),
});
// Evidence is a protocol payload, never model context. Oversize inputs reject
// as a whole; they are never truncated into a seemingly valid attestation.
const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
function failure(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    code: "TEE_DSTACK_EVIDENCE_REJECTED",
    ...(cause === undefined ? {} : { cause }),
  });
}
function equalHex(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}
async function assertPinnedFile(path: string, digest: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw failure("Verifier executable/configuration must be regular files");
  }
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (!equalHex(actual, digest))
    throw failure("Verifier executable/configuration digest mismatch");
}

/** Collect raw evidence only; callers must independently verify its claims. */
export async function collectDstackAttestation(
  socketPath: string,
  reportData: string,
  signal: AbortSignal,
): Promise<string> {
  if (!(await lstat(socketPath)).isSocket())
    throw failure("Dstack endpoint must be a Unix socket");
  const body = JSON.stringify({ report_data: reportData });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/v1/Attest",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        signal,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(failure("Guest-v1 attestation request was rejected"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PROTOCOL_BYTES) {
            req.destroy(
              failure("Guest attestation exceeds protocol size limit"),
            );
          } else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const parsed = z
              .object({ attestation: hex })
              .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            resolve(parsed.attestation);
          } catch (error) {
            // error-policy:J3 Invalid guest replies never produce usable evidence.
            reject(failure("Malformed guest attestation response", error));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function verify(
  config: z.output<typeof dstackVerifierConfiguration>,
  attestation: string,
  signal: AbortSignal,
): Promise<string> {
  await assertPinnedFile(config.verifierPath, config.verifierSha256);
  await assertPinnedFile(
    config.verifierConfigPath,
    config.verifierConfigSha256,
  );
  const dir = await mkdtemp(join(tmpdir(), "eliza-dstack-evidence-"));
  try {
    const input = join(dir, "attestation.json");
    await writeFile(input, JSON.stringify({ attestation }), { mode: 0o600 });
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      // Do not inherit DSTACK_VERIFIER_* overrides or dynamic-loader variables.
      // The pinned config owns trust roots, collateral services and image URLs.
      const child = spawn(
        config.verifierPath,
        ["--config", config.verifierConfigPath, "--verify", input],
        {
          env: { PATH: "/usr/bin:/bin", RUST_LOG: "error" },
          stdio: ["ignore", "pipe", "pipe"],
          // Linux verifier helpers share a process group so cancellation also
          // stops image-measurement subprocesses retaining the output pipes.
          detached: process.platform !== "win32",
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected: Error | undefined;
      const stop = (error: Error) => {
        rejected ??= error;
        if (process.platform === "win32" || child.pid === undefined) {
          child.kill("SIGKILL");
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          // error-policy:J6 An already exited process group needs no teardown.
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          ) {
            logger.warn(
              "[DstackEvidence] Could not terminate verifier process group",
            );
            rejected = failure(
              "Could not terminate verifier process group",
              error,
            );
            child.kill("SIGKILL");
          }
        }
      };
      const abort = () =>
        stop(failure("Dstack verification aborted", signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PROTOCOL_BYTES)
          stop(failure("Verifier response exceeds protocol size limit"));
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PROTOCOL_BYTES)
          stop(failure("Verifier diagnostics exceed protocol size limit"));
      });
      child.on("error", (error) => {
        rejected ??= error;
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (rejected) reject(rejected);
        else if (code !== 0)
          reject(failure("Pinned verifier rejected the attestation"));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Remote appraisal deliberately has no local guest socket dependency. */
export const dstackVerifierConfiguration = dstackEvidenceConfiguration.omit({
  socketPath: true,
});
export type DstackVerifierConfig = z.input<typeof dstackVerifierConfiguration>;
/** Recheck signed authority immediately before a protected operation. */
export function assertDstackReleaseCurrent(
  config: z.output<typeof dstackVerifierConfiguration>,
): void {
  const validity = config.releaseValidity;
  if (
    validity &&
    (Date.now() < Date.parse(validity.notBefore) ||
      Date.now() >= Date.parse(validity.expiresAt))
  ) {
    throw failure("Signed release identity is outside its validity interval");
  }
}

/** Verify received raw evidence, never a remote caller's normalized claims. */
export async function verifyDstackAttestation(
  input: DstackVerifierConfig,
  attestation: string,
  challenge: TeeReportDataChallenge,
  abortSignal?: AbortSignal,
): Promise<TeeEvidence> {
  const config = dstackVerifierConfiguration.parse(input);
  sha256.parse(challenge.reportDataHex);
  hex.parse(challenge.nonce);
  hex.parse(attestation);
  if (Buffer.byteLength(attestation) > MAX_PROTOCOL_BYTES)
    throw failure("Attestation exceeds protocol size limit");
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, timeout])
    : timeout;
  signal.throwIfAborted();
  assertDstackReleaseCurrent(config);
  try {
    const result = responseSchema.parse(
      JSON.parse(await verify(config, attestation, signal)),
    );
    signal.throwIfAborted();
    assertDstackReleaseCurrent(config);
    const d = result.details;
    if (
      d.tee_variant !== config.variant ||
      !equalHex(d.report_data, challenge.reportDataHex.padEnd(128, "0"))
    ) {
      throw failure("Verified variant or report-data challenge mismatch");
    }
    if (
      d.os_image_is_dev === true ||
      (d.tee_variant === "dstack-tdx" &&
        (d.tcb_status !== "UpToDate" || !d.acpi_tables_verified))
    ) {
      throw failure(
        "Verified platform does not meet production appraisal policy",
      );
    }
    if (d.tee_variant === "dstack-nitro-enclave" && d.tcb_status !== null) {
      throw failure("Unexpected Nitro Enclave TCB semantics");
    }
    const app = d.app_info;
    if (
      !equalHex(app.app_id, config.appId) ||
      !equalHex(app.compose_hash, config.composeHash) ||
      !equalHex(app.os_image_hash, config.osImageHash)
    ) {
      throw failure(
        "Verified deployment identity does not match admission policy",
      );
    }
    return {
      kind: d.tee_variant === "dstack-tdx" ? "tdx" : "nitro",
      provider: "dstack",
      reportData: challenge.reportDataHex.toLowerCase(),
      measurements: {
        compose: app.compose_hash,
        os: app.os_image_hash,
        boot: app.mr_aggregated,
      },
      // These platforms' pinned verifier rejects debug reports. No GPU, NPU,
      // I/O, secure-boot or lifecycle claims are inferred from generic validity.
      claims: { debugDisabled: true },
      freshness: {
        nonce: challenge.nonce,
        timestamp: new Date().toISOString(),
        verifier: `dstack-verifier:sha256:${config.verifierSha256}`,
      },
      raw: { attestation, verification: result },
    };
  } catch (error) {
    // error-policy:J2 Remote evidence failures never produce usable trust.
    throw failure("Dstack raw evidence appraisal failed", error);
  }
}

/** Uses the pinned dstack guest-v1 and verifier --verify JSON wire contracts. */
export function createDstackEvidenceProvider(
  input: DstackEvidenceConfig,
): TeeReportDataBoundEvidenceProvider & {
  collectEvidenceWithReportData(
    challenge: TeeReportDataChallenge,
    signal?: AbortSignal,
  ): Promise<TeeEvidence>;
} {
  const config = dstackEvidenceConfiguration.parse(input);
  const collect = async (
    challenge: TeeReportDataChallenge,
    abortSignal?: AbortSignal,
  ): Promise<TeeEvidence> => {
    sha256.parse(challenge.reportDataHex);
    hex.parse(challenge.nonce);
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, timeout])
      : timeout;
    signal.throwIfAborted();
    try {
      assertDstackReleaseCurrent(config);
      const attestation = await collectDstackAttestation(
        config.socketPath,
        challenge.reportDataHex,
        signal,
      );
      return await verifyDstackAttestation(
        config,
        attestation,
        challenge,
        signal,
      );
    } catch (error) {
      // error-policy:J2 Preserve the failing boundary without fabricating trust.
      throw failure("Dstack evidence collection/appraisal failed", error);
    }
  };
  const provider = {
    id: "dstack-guest-v1-pinned-verifier",
    collectEvidence: () => {
      const nonce = randomBytes(32).toString("hex");
      return collect({ nonce, reportDataHex: nonce });
    },
    collectEvidenceWithReportData: collect,
  };
  verifiedProviders.set(provider, config);
  return Object.freeze(provider);
}
