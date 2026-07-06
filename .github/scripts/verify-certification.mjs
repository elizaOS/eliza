#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const PUBLIC_KEY_RELPATH =
  ".github/certification/certification-public-key.pem";

process.chdir(REPO_ROOT);

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function relative(filePath) {
  return path.relative(REPO_ROOT, filePath) || ".";
}

function escapeAnnotation(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .slice(0, 1000);
}

function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath !== "") {
    fs.appendFileSync(summaryPath, `${markdown}\n`);
    return;
  }
  process.stdout.write(`${markdown}\n`);
}

function emitFailureAnnotations(failures) {
  for (const failure of failures) {
    process.stderr.write(
      `::error title=${escapeAnnotation(failure.code)}::${escapeAnnotation(
        failure.message,
      )}\n`,
    );
  }
}

function finishFailure(context, failures) {
  writeSummary(renderSummary("FAIL", context, failures));
  emitFailureAnnotations(failures);
  process.exitCode = 1;
}

function finishPass(context) {
  writeSummary(renderSummary("PASS", context, []));
  process.exitCode = 0;
}

function resolveInputPath(input) {
  return path.isAbsolute(input) ? input : path.join(REPO_ROOT, input);
}

function walkFiles(root, basename, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, basename, out);
      continue;
    }
    if (entry.isFile() && entry.name === basename) out.push(filePath);
  }
  return out;
}

function locateCertification() {
  const configured = env("CERTIFICATION_PATH");
  if (configured !== undefined) {
    const filePath = resolveInputPath(configured);
    return fs.existsSync(filePath) ? { filePath } : { missing: filePath };
  }

  const candidates = [];
  const rootCert = path.join(REPO_ROOT, "certification.json");
  if (fs.existsSync(rootCert)) candidates.push(rootCert);
  candidates.push(
    ...walkFiles(path.join(REPO_ROOT, "evidence", "runs"), "certification.json"),
  );
  candidates.sort();

  if (candidates.length === 0) return { none: true };
  if (candidates.length > 1) return { multiple: candidates };
  return { filePath: candidates[0] };
}

function locateBundle(certPath) {
  const configured = env("CERTIFICATION_BUNDLE_PATH");
  const bundleDir =
    configured !== undefined ? resolveInputPath(configured) : path.dirname(certPath);
  const manifest = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifest)) return { missing: bundleDir };
  return { bundleDir };
}

function baseRefSpec() {
  const baseRef = env("BASE_REF", env("GITHUB_BASE_REF", "main"));
  if (!/^[A-Za-z0-9._/-]+$/.test(baseRef)) {
    return { error: `unsafe base ref: ${baseRef}` };
  }
  return { ref: `refs/remotes/origin/${baseRef}`, baseRef };
}

function materializeBasePublicKey() {
  const spec = baseRefSpec();
  if (spec.error !== undefined) return { error: spec.error };

  const show = spawnSync(
    "git",
    ["show", `${spec.ref}:${PUBLIC_KEY_RELPATH}`],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (show.status !== 0) {
    return {
      error:
        `trusted certification public key is missing on base branch ${spec.baseRef}: ` +
        PUBLIC_KEY_RELPATH,
      baseRef: spec.baseRef,
    };
  }

  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-trust-anchor-"));
  const keyPath = path.join(keyDir, "certification-public-key.pem");
  fs.writeFileSync(keyPath, show.stdout);
  return { keyPath, keyDir, baseRef: spec.baseRef };
}

function runVerifier({ certPath, bundleDir, keyPath }) {
  const args = [
    "packages/evidence/src/certify/cli.ts",
    "verify",
    "--cert",
    certPath,
    "--pubkey",
    keyPath,
    "--bundle",
    bundleDir,
    "--max-age-hours",
    env("CERT_MAX_AGE_HOURS", "72"),
    "--required-tier",
    env("CERT_REQUIRED_TIER", "full"),
    "--json",
  ];
  const expectedCommit = env("PR_HEAD_SHA", env("GITHUB_SHA"));
  if (expectedCommit !== undefined) {
    args.splice(args.length - 1, 0, "--expected-commit", expectedCommit);
  }
  const requirementsPath = env("CERT_REQUIREMENTS_PATH");
  if (requirementsPath !== undefined) {
    args.splice(args.length - 1, 0, "--requirements", resolveInputPath(requirementsPath));
  }

  const result = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return {
      report: undefined,
      failures: [
        {
          code: "verification-error",
          message:
            "certify:verify did not emit a JSON report" +
            (result.stderr ? `: ${result.stderr.trim().slice(0, 500)}` : ""),
        },
      ],
    };
  }

  return {
    report,
    failures: Array.isArray(report.failures) ? [...report.failures] : [],
  };
}

function applyPromotionPolicy(report, failures) {
  const expectedCommit = env("PR_HEAD_SHA", env("GITHUB_SHA"));
  if (
    expectedCommit !== undefined &&
    report?.payload?.commit !== undefined &&
    report.payload.commit !== expectedCommit &&
    !failures.some((failure) => failure.code === "commit-mismatch")
  ) {
    failures.push({
      code: "commit-mismatch",
      message: `certification commit ${report.payload.commit} does not match PR head ${expectedCommit}`,
      context: { expectedCommit, actualCommit: report.payload.commit },
    });
  }
}

function verdictCounts(report) {
  const counts = { pass: 0, fail: 0, waived: 0 };
  for (const verdict of report?.payload?.verdicts ?? []) {
    if (verdict.verdict in counts) counts[verdict.verdict] += 1;
  }
  return counts;
}

function renderSummary(status, context, failures) {
  const report = context.report;
  const payload = report?.payload;
  const counts = verdictCounts(report);
  const lines = [
    "# Certification Verify",
    "",
    `**Status:** ${status}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Base ref | \`${context.baseRef ?? "(unknown)"}\` |`,
    `| Certificate | \`${context.certPath ? relative(context.certPath) : "(missing)"}\` |`,
    `| Bundle | \`${context.bundleDir ? relative(context.bundleDir) : "(missing)"}\` |`,
    `| Required tier | \`${env("CERT_REQUIRED_TIER", "full")}\` |`,
    `| Max age | \`${env("CERT_MAX_AGE_HOURS", "72")}h\` |`,
  ];

  if (payload !== undefined) {
    lines.push(
      `| Certified commit | \`${payload.commit}\` |`,
      `| Branch/base | \`${payload.branch} -> ${payload.baseRef}\` |`,
      `| Tier | \`${payload.tier}\` |`,
      `| Reviewer | \`${payload.reviewer.kind}:${payload.reviewer.id}\` |`,
      `| Verdicts | pass=${counts.pass}, fail=${counts.fail}, waived=${counts.waived} |`,
      `| Created at | \`${payload.createdAt}\` |`,
    );
  }

  if (failures.length > 0) {
    lines.push("", "## Failures", "", "| Code | Message |", "| --- | --- |");
    for (const failure of failures) {
      lines.push(
        `| \`${failure.code}\` | ${String(failure.message).replaceAll("|", "\\|")} |`,
      );
    }
  }

  const verdicts = payload?.verdicts ?? [];
  if (verdicts.length > 0) {
    lines.push("", "## Verdicts", "", "| Subject | Verdict | Notes |", "| --- | --- | --- |");
    for (const verdict of verdicts.slice(0, 50)) {
      lines.push(
        `| \`${verdict.subject}\` | \`${verdict.verdict}\` | ${
          verdict.notes === undefined ? "" : String(verdict.notes).replaceAll("|", "\\|")
        } |`,
      );
    }
    if (verdicts.length > 50) {
      lines.push(`| ... | ... | ${verdicts.length - 50} more verdict(s) omitted |`);
    }
  }

  if (failures.length > 0 && context.trustAnchorMissing) {
    lines.push(
      "",
      "The certification public key must be committed on the protected base branch before this check is made required.",
    );
  }

  return `${lines.join("\n")}\n`;
}

const context = {};
const trustAnchor = materializeBasePublicKey();
context.baseRef = trustAnchor.baseRef ?? env("BASE_REF", env("GITHUB_BASE_REF", "main"));
if (trustAnchor.error !== undefined) {
  context.trustAnchorMissing = true;
  finishFailure(context, [
    { code: "trust-anchor-missing", message: trustAnchor.error },
  ]);
} else {
  try {
    const cert = locateCertification();
    if (cert.none) {
      finishFailure(context, [
        {
          code: "certification-missing",
          message:
            "no certification.json found; commit evidence/runs/<run-id>/certification.json on the promotion branch",
        },
      ]);
    } else if (cert.missing !== undefined) {
      finishFailure(context, [
        {
          code: "certification-missing",
          message: `configured certification path does not exist: ${cert.missing}`,
        },
      ]);
    } else if (cert.multiple !== undefined) {
      finishFailure(context, [
        {
          code: "certification-ambiguous",
          message:
            "multiple certification.json files found; set CERTIFICATION_PATH to the intended file: " +
            cert.multiple.map(relative).join(", "),
        },
      ]);
    } else {
      context.certPath = cert.filePath;
      const bundle = locateBundle(cert.filePath);
      if (bundle.missing !== undefined) {
        context.bundleDir = bundle.missing;
        finishFailure(context, [
          {
            code: "bundle-missing",
            message: `certification bundle is missing manifest.json: ${bundle.missing}`,
          },
        ]);
      } else {
        context.bundleDir = bundle.bundleDir;
        const verification = runVerifier({
          certPath: cert.filePath,
          bundleDir: bundle.bundleDir,
          keyPath: trustAnchor.keyPath,
        });
        context.report = verification.report;
        const failures = verification.failures;
        applyPromotionPolicy(verification.report, failures);
        if (verification.report?.ok === false && failures.length === 0) {
          failures.push({
            code: "verification-error",
            message: "certify:verify returned ok:false without failures",
          });
        }
        if (failures.length > 0) finishFailure(context, failures);
        else finishPass(context);
      }
    }
  } finally {
    if (trustAnchor.keyDir !== undefined) {
      fs.rmSync(trustAnchor.keyDir, { recursive: true, force: true });
    }
  }
}
