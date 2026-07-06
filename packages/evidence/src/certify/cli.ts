/**
 * Thin CLI over the certification library: `keygen`, `rollup`, `sign`,
 * `verify`. All logic lives in the certify modules — this file parses argv,
 * resolves defaults, and formats output. It is a process boundary, so writing
 * to the injected stdout/stderr is the product here; the library never logs.
 * `verify --json` is the machine contract the CI gate (#14547) consumes: the
 * full `CertificationVerifyReport` on stdout, exit 0 iff `ok`. The private
 * key never touches stdout/stderr except under the explicit
 * `keygen --print-private-key` flag, and is never written to disk by any
 * command.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundle } from "../bundle.ts";
import { canonicalJsonBytes } from "../canonical.ts";
import { EvidenceError } from "../errors.ts";
import { parseMeta, TIERS, type Tier } from "../schema.ts";
import {
  generateCertificationKeypair,
  resolveSigningKey,
  SIGNING_KEY_ENV_VAR,
} from "./keys.ts";
import {
  type CertificationRequirements,
  parseRequirements,
  parseVerdictsDocument,
  rollupBundle,
} from "./rollup.ts";
import {
  type CertificationPayload,
  REVIEWER_KINDS,
  type ReviewerKind,
} from "./schema.ts";
import { signCertification, verifyCertification } from "./sign.ts";

const USAGE = `Usage:
  certify:keygen  -- [--print-private-key] [--pubkey-out <file>]
  certify:rollup  -- --bundle <dir> [--requirements <file>] [--out <file>]
  certify:sign    -- --bundle <dir> --verdicts <file> --reviewer-id <id> --reviewer-kind <agent|human>
                     [--reviewer-model <model>] [--key-file <pem>] [--base-ref <ref>]
                     [--expires-hours <n>] [--out <file>]
  certify:verify  -- --cert <file> --pubkey <pem-file> [--bundle <dir>] [--requirements <file>]
                     [--expected-commit <sha>] [--max-age-hours <n>]
                     [--required-tier <cpu|gpu|full>] [--json]

keygen   Generate an Ed25519 keypair; prints the public key + fingerprint.
         The private key is printed ONLY with --print-private-key and is
         never written to disk. Signing reads ${SIGNING_KEY_ENV_VAR} or --key-file.
rollup   Walk a finalized bundle and emit draft verdicts for reviewer editing.
sign     Build the certification payload from bundle meta + manifest sha +
         reviewed verdicts, sign it, and write <bundle>/certification.json.
verify   Offline verification (the CI gate path): exit 0 iff the
         certification is valid; --json prints the full report on stdout.`;

/** Output sinks; injectable so tests capture instead of spawning. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

interface ParsedFlags {
  flags: Map<string, string>;
  booleans: Set<string>;
}

function parseFlags(
  argv: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): ParsedFlags {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanFlags.includes(arg)) {
      booleans.add(arg);
      continue;
    }
    if (valueFlags.includes(arg)) {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new EvidenceError(`${arg} requires a value`, {
          code: "CLI_USAGE",
        });
      }
      flags.set(arg, next);
      index += 1;
      continue;
    }
    throw new EvidenceError(`unknown argument: ${arg}`, { code: "CLI_USAGE" });
  }
  return { flags, booleans };
}

function requireFlag(parsed: ParsedFlags, flag: string): string {
  const value = parsed.flags.get(flag);
  if (value === undefined) {
    throw new EvidenceError(`${flag} is required`, { code: "CLI_USAGE" });
  }
  return value;
}

function parseTierFlag(raw: string): Tier {
  if (!(TIERS as readonly string[]).includes(raw)) {
    throw new EvidenceError(
      `--required-tier must be one of ${TIERS.join("|")}, got: ${raw}`,
      { code: "CLI_USAGE" },
    );
  }
  return raw as Tier;
}

function parsePositiveNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new EvidenceError(`${flag} must be a positive number, got: ${raw}`, {
      code: "CLI_USAGE",
    });
  }
  return value;
}

function runKeygen(argv: string[], io: CliIo): number {
  const parsed = parseFlags(argv, ["--pubkey-out"], ["--print-private-key"]);
  const keypair = generateCertificationKeypair();
  const pubkeyOut = parsed.flags.get("--pubkey-out");
  if (pubkeyOut !== undefined) {
    fs.writeFileSync(pubkeyOut, keypair.publicKeyPem);
    io.err(`public key written: ${pubkeyOut}`);
  }
  io.out(keypair.publicKeyPem.trimEnd());
  io.out(`fingerprint: ${keypair.fingerprint}`);
  if (parsed.booleans.has("--print-private-key")) {
    io.err(
      "WARNING: private key follows on stdout. Store it as the " +
        `${SIGNING_KEY_ENV_VAR} secret; never commit it, never write it to disk.`,
    );
    io.out(keypair.privateKeyPem.trimEnd());
  }
  return 0;
}

function readJsonFile(filePath: string, what: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a missing input file is a
    // usage-level failure the invoking harness must see.
    throw new EvidenceError(`${what} unreadable: ${filePath}`, {
      code: "CLI_INPUT_UNREADABLE",
      cause: error,
      context: { filePath },
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // error-policy:J3 untrusted input — malformed JSON is a typed failure.
    throw new EvidenceError(`${what} is not valid JSON: ${filePath}`, {
      code: "CLI_INPUT_INVALID",
      cause: error,
      context: { filePath },
    });
  }
}

function runRollup(argv: string[], io: CliIo): number {
  const parsed = parseFlags(argv, ["--bundle", "--requirements", "--out"], []);
  const bundleDir = path.resolve(requireFlag(parsed, "--bundle"));
  const requirementsPath = parsed.flags.get("--requirements");
  let requirements: CertificationRequirements | undefined;
  if (requirementsPath !== undefined) {
    requirements = parseRequirements(
      readJsonFile(requirementsPath, "requirements file"),
      requirementsPath,
    );
  }
  const result = rollupBundle(bundleDir, { requirements });
  const json = JSON.stringify(result, null, 2);
  const outPath = parsed.flags.get("--out");
  if (outPath !== undefined) {
    fs.writeFileSync(outPath, `${json}\n`);
    io.err(`draft verdicts written: ${outPath}`);
  } else {
    io.out(json);
  }
  const { counts } = result.summary;
  io.err(
    `subjects: ${result.verdicts.length} (pass=${counts.pass} fail=${counts.fail} waived=${counts.waived}); ` +
      `lanes=${result.summary.lanes.length} analyses=${result.summary.analysesScanned}`,
  );
  return 0;
}

async function runSign(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseFlags(
    argv,
    [
      "--bundle",
      "--verdicts",
      "--reviewer-id",
      "--reviewer-kind",
      "--reviewer-model",
      "--key-file",
      "--base-ref",
      "--expires-hours",
      "--out",
    ],
    [],
  );
  const bundleDir = path.resolve(requireFlag(parsed, "--bundle"));
  const verdictsPath = requireFlag(parsed, "--verdicts");
  const reviewerId = requireFlag(parsed, "--reviewer-id");
  const reviewerKindRaw = requireFlag(parsed, "--reviewer-kind");
  if (!(REVIEWER_KINDS as readonly string[]).includes(reviewerKindRaw)) {
    throw new EvidenceError(
      `--reviewer-kind must be one of ${REVIEWER_KINDS.join("|")}, got: ${reviewerKindRaw}`,
      { code: "CLI_USAGE" },
    );
  }
  const reviewerKind = reviewerKindRaw as ReviewerKind;
  const reviewerModel = parsed.flags.get("--reviewer-model");

  // Refuse to sign over a tampered or incomplete bundle: the signature's
  // whole meaning is "these verdicts were reviewed against this exact bundle".
  const bundleReport = await verifyBundle(bundleDir);
  if (!bundleReport.ok) {
    for (const issue of bundleReport.issues) {
      io.err(`  ${issue.issue}: ${issue.path}`);
    }
    throw new EvidenceError(
      `refusing to sign: bundle integrity check failed with ${bundleReport.issues.length} issue(s)`,
      { code: "SIGN_BUNDLE_TAMPERED", context: { bundleDir } },
    );
  }

  const meta = parseMeta(
    readJsonFile(path.join(bundleDir, "meta.json"), "bundle meta"),
    path.join(bundleDir, "meta.json"),
  );
  const { verdicts } = parseVerdictsDocument(
    readJsonFile(verdictsPath, "verdicts document"),
    verdictsPath,
  );

  const createdAt = new Date();
  const expiresHoursRaw = parsed.flags.get("--expires-hours");
  const payload: CertificationPayload = {
    schema: 1,
    bundleSha: bundleReport.manifestSha256,
    commit: meta.commit,
    branch: meta.branch,
    baseRef: parsed.flags.get("--base-ref") ?? "develop",
    tier: meta.tier,
    verdicts,
    reviewer: {
      kind: reviewerKind,
      id: reviewerId,
      ...(reviewerModel !== undefined ? { model: reviewerModel } : {}),
    },
    createdAt: createdAt.toISOString(),
    ...(expiresHoursRaw !== undefined
      ? {
          expiresAt: new Date(
            createdAt.getTime() +
              parsePositiveNumber("--expires-hours", expiresHoursRaw) *
                3_600_000,
          ).toISOString(),
        }
      : {}),
  };

  const key = resolveSigningKey({
    env: process.env,
    keyFile: parsed.flags.get("--key-file"),
  });
  const certification = signCertification(payload, key);
  const outPath =
    parsed.flags.get("--out") ?? path.join(bundleDir, "certification.json");
  fs.writeFileSync(outPath, canonicalJsonBytes(certification));

  const counts = { pass: 0, fail: 0, waived: 0 };
  for (const verdict of verdicts) counts[verdict.verdict] += 1;
  io.out(`certification written: ${outPath}`);
  io.out(
    `  commit ${payload.commit} (${payload.branch} → ${payload.baseRef}) tier=${payload.tier}`,
  );
  io.out(
    `  verdicts: ${verdicts.length} (pass=${counts.pass} fail=${counts.fail} waived=${counts.waived})`,
  );
  io.out(`  reviewer: ${reviewerKind}:${reviewerId}`);
  io.out(`  key fingerprint: ${certification.signature.publicKeyFingerprint}`);
  return 0;
}

async function runVerify(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseFlags(
    argv,
    [
      "--cert",
      "--bundle",
      "--requirements",
      "--pubkey",
      "--expected-commit",
      "--max-age-hours",
      "--required-tier",
    ],
    ["--json"],
  );
  const certPath = path.resolve(requireFlag(parsed, "--cert"));
  const pubkeyPath = path.resolve(requireFlag(parsed, "--pubkey"));
  let publicKeyPem: string;
  try {
    publicKeyPem = fs.readFileSync(pubkeyPath, "utf8");
  } catch (error) {
    // error-policy:J2 context-adding rethrow — no trusted key means the
    // verifier is misconfigured; that must never read as "cert invalid".
    throw new EvidenceError(`trusted public key unreadable: ${pubkeyPath}`, {
      code: "CERT_KEY_UNREADABLE",
      cause: error,
      context: { pubkeyPath },
    });
  }

  const maxAgeRaw = parsed.flags.get("--max-age-hours");
  const tierRaw = parsed.flags.get("--required-tier");
  const bundleFlag = parsed.flags.get("--bundle");
  const requirementsPath = parsed.flags.get("--requirements");
  let requirements: CertificationRequirements | undefined;
  if (requirementsPath !== undefined) {
    requirements = parseRequirements(
      readJsonFile(requirementsPath, "requirements file"),
      requirementsPath,
    );
  }
  const report = await verifyCertification(certPath, {
    publicKeyPem,
    ...(bundleFlag !== undefined
      ? { bundleDir: path.resolve(bundleFlag) }
      : {}),
    ...(requirements !== undefined ? { requirements } : {}),
    ...(parsed.flags.get("--expected-commit") !== undefined
      ? { expectedCommit: parsed.flags.get("--expected-commit") }
      : {}),
    ...(maxAgeRaw !== undefined
      ? { maxAgeHours: parsePositiveNumber("--max-age-hours", maxAgeRaw) }
      : {}),
    ...(tierRaw !== undefined ? { requiredTier: parseTierFlag(tierRaw) } : {}),
  });

  if (parsed.booleans.has("--json")) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`certification ${certPath}`);
    if (report.payload !== undefined) {
      const { payload } = report;
      io.out(
        `  commit ${payload.commit} (${payload.branch} → ${payload.baseRef}) tier=${payload.tier}`,
      );
      io.out(
        `  reviewer ${payload.reviewer.kind}:${payload.reviewer.id}` +
          (payload.reviewer.model !== undefined
            ? ` (${payload.reviewer.model})`
            : ""),
      );
      io.out(
        `  verdicts: ${payload.verdicts.length}  createdAt: ${payload.createdAt}`,
      );
    }
    for (const failure of report.failures) {
      io.err(`  ${failure.code}: ${failure.message}`);
    }
    io.out(report.ok ? "  VERIFIED" : "  FAILED");
  }
  return report.ok ? 0 : 1;
}

/** Parse argv (without node/script prefix) and run; returns the exit code. */
export async function runCertifyCli(
  argv: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "keygen") return runKeygen(rest, io);
    if (command === "rollup") return runRollup(rest, io);
    if (command === "sign") return await runSign(rest, io);
    if (command === "verify") return await runVerify(rest, io);
    io.err(USAGE);
    return command === undefined || command === "--help" || command === "-h"
      ? 0
      : 1;
  } catch (error) {
    // error-policy:J1 process boundary — translate typed failures into a
    // structured stderr line + non-zero exit for the invoking harness.
    if (error instanceof EvidenceError) {
      io.err(`error [${error.code}]: ${error.message}`);
      if (error.code === "CLI_USAGE") io.err(USAGE);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  process.exitCode = await runCertifyCli(process.argv.slice(2), io);
}
