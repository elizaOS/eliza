import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SPECULATIVE_BENCHMARK_SCHEMA =
  "eliza.speculative-benchmark.v1";
export const SPECULATORS = new Set(["dflash", "eagle3", "mtp"]);

export function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function assertSpeculator(speculator) {
  if (!SPECULATORS.has(speculator)) {
    throw new Error(
      `unsupported speculative benchmark speculator: ${speculator}`,
    );
  }
}

export function speculativeReportDir(verifyDir, speculator) {
  assertSpeculator(speculator);
  return path.join(verifyDir, "..", "reports", `${speculator}-bench`);
}

export function timestampedSpeculativeReportPath(verifyDir, speculator) {
  return path.join(
    speculativeReportDir(verifyDir, speculator),
    `${speculator}-bench-${timestamp()}.json`,
  );
}

export function latestSpeculativeReportPath(verifyDir, speculator) {
  return path.join(
    speculativeReportDir(verifyDir, speculator),
    `${speculator}-bench-latest.json`,
  );
}

export function inferSpeculativeBackend(binary) {
  const value = String(binary ?? "").toLowerCase();
  if (value.includes("metal")) return "metal";
  if (value.includes("cuda")) return "cuda";
  if (value.includes("vulkan")) return "vulkan";
  if (value.includes("rocm") || value.includes("hip")) return "rocm";
  if (value.includes("cpu")) return "cpu";
  return "unknown";
}

export function fileSha256(file) {
  if (!file || !fs.existsSync(file)) {
    return { exists: false, sha256: null };
  }
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return { exists: true, sha256: hash.digest("hex") };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deriveStatus({ status, available, failure }) {
  if (status) return status;
  if (failure) return "fail";
  if (available === false) return "needs-data";
  return "pass";
}

export function buildSpeculativeBenchmarkReport({
  speculator,
  generatedAt = new Date().toISOString(),
  verifier,
  tier,
  targetModel,
  drafterModel,
  specBinary,
  benchTokens = null,
  withDrafter = null,
  withoutDrafter = null,
  speedup = null,
  acceptanceRate = null,
  status = null,
  failure = null,
  backend = null,
  extra = {},
} = {}) {
  assertSpeculator(speculator);
  const binaryHash = fileSha256(specBinary);
  const drafted = finiteOrNull(withDrafter?.drafted);
  const accepted = finiteOrNull(withDrafter?.accepted);
  const resolvedAcceptanceRate =
    finiteOrNull(acceptanceRate) ??
    finiteOrNull(withDrafter?.acceptanceRate) ??
    (drafted !== null && accepted !== null && drafted > 0
      ? accepted / drafted
      : null);
  const withTps = finiteOrNull(withDrafter?.tokensPerSecond);
  const withoutTps = finiteOrNull(withoutDrafter?.tokensPerSecond);
  const resolvedSpeedup =
    finiteOrNull(speedup) ??
    (withTps !== null && withoutTps !== null && withoutTps > 0
      ? withTps / withoutTps
      : null);
  const available =
    withDrafter?.available === false || withoutDrafter?.available === false
      ? false
      : withDrafter || withoutDrafter
        ? true
        : binaryHash.exists;
  const resolvedFailure =
    failure ??
    withDrafter?.failure ??
    withDrafter?.dflashFailure ??
    withoutDrafter?.failure ??
    null;
  const resolvedBackend = backend ?? inferSpeculativeBackend(specBinary);
  const resolvedStatus = deriveStatus({
    status,
    available,
    failure: resolvedFailure,
  });

  return {
    reportSchema: SPECULATIVE_BENCHMARK_SCHEMA,
    generatedAt,
    verifier,
    speculator,
    tier,
    targetModel,
    drafterModel,
    specBinary,
    benchTokens,
    available,
    status: resolvedStatus,
    failure: resolvedFailure,
    backend: resolvedBackend,
    binary: {
      path: specBinary,
      exists: binaryHash.exists,
      sha256: binaryHash.sha256,
    },
    drafted,
    accepted,
    acceptanceRate: resolvedAcceptanceRate,
    speedup: resolvedSpeedup,
    withDrafter,
    withoutDrafter,
    summary: {
      speculator,
      tier,
      backend: resolvedBackend,
      binarySha256: binaryHash.sha256,
      drafted,
      accepted,
      acceptanceRate: resolvedAcceptanceRate,
      speedup: resolvedSpeedup,
      status: resolvedStatus,
      failure: resolvedFailure,
    },
    ...extra,
  };
}

export function writeSpeculativeBenchmarkReport(
  reportPath,
  report,
  { verifyDir, writeLatest = true } = {},
) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (writeLatest) {
    const latestPath =
      verifyDir && report?.speculator
        ? latestSpeculativeReportPath(verifyDir, report.speculator)
        : path.join(
            path.dirname(reportPath),
            `${report.speculator ?? "speculative"}-bench-latest.json`,
          );
    fs.mkdirSync(path.dirname(latestPath), { recursive: true });
    fs.writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`);
    return { reportPath, latestPath };
  }
  return { reportPath, latestPath: null };
}
