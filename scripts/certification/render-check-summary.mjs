#!/usr/bin/env node
/**
 * Render the certification-verify gate result for humans. Consumes the
 * `certify:verify --json` report plus the commit-drift outcome and emits
 * either GitHub step-summary markdown (`--mode summary`) or `::error`
 * workflow-command annotations (`--mode annotations`). Display only — every
 * pass/fail decision was already made by `certify:verify` and
 * check-commit-drift.mjs; this file must never turn a red input green.
 *
 * The point of the summary is the trust handoff: the human merging to main
 * sees WHO certified WHAT (reviewer identity is part of the signed payload
 * precisely because a signature proves custody, not diligence).
 */

import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Display-only fingerprint (first 16 hex of sha256 over the SPKI DER) so the
 * summary names which trusted key was used. The canonical implementation the
 * verifier trusts lives in packages/evidence/src/certify/keys.ts.
 */
export function fingerprintPem(pem) {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

function readJsonIfPossible(filePath) {
  if (filePath === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function formatAge(createdAt, now = Date.now()) {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return "unparseable createdAt";
  const hours = (now - createdMs) / 3_600_000;
  return `${hours.toFixed(1)}h old`;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const VERDICT_ICONS = { pass: "✅", fail: "❌", waived: "⚠️" };

export function renderSummary({ report, drift, trustedFingerprint, certPath }) {
  const lines = ["## certification-verify", ""];
  const verifyOk = report?.ok === true;
  // No drift outcome supplied (e.g. the selftest's direct render) means drift
  // was not part of this evaluation; the workflow always passes one.
  const driftOk =
    drift === undefined ||
    drift.result === "match" ||
    drift.result === "allowed-drift";
  lines.push(
    `**Result:** ${verifyOk && driftOk ? "✅ certification verified" : "❌ certification rejected"}`,
    "",
  );
  lines.push(`- Certification: \`${certPath}\``);
  lines.push(
    `- Trusted public key (from the base branch): fingerprint \`${trustedFingerprint}\``,
  );

  const payload = report?.payload;
  if (payload !== undefined) {
    const reviewer = payload.reviewer ?? {};
    const model = reviewer.model !== undefined ? ` (${reviewer.model})` : "";
    lines.push(
      `- Reviewer: **${reviewer.kind}:${reviewer.id}**${model}`,
      `- Tier: \`${payload.tier}\` · Commit: \`${payload.commit}\` (\`${payload.branch}\` → \`${payload.baseRef}\`)`,
      `- Created: \`${payload.createdAt}\` (${formatAge(payload.createdAt)})`,
    );
  } else {
    lines.push(
      "- Reviewer/tier/commit: unavailable — the certification payload did not parse",
    );
  }
  if (report !== undefined) {
    lines.push(
      report.bundle !== undefined
        ? `- Bundle: re-hashed ${report.bundle.artifactCount} artifact(s); rollup completeness re-derived`
        : "- Bundle: not supplied to verifier — promotion gate requires `evidence/bundle` and should fail before this point",
    );
  }

  if (drift !== undefined) {
    lines.push("", "### Commit drift", "");
    lines.push(
      `- ${driftOk ? "✅" : "❌"} \`${drift.result}\`: ${drift.detail}`,
    );
    if ((drift.driftPaths ?? []).length > 0) {
      lines.push("", "<details><summary>Drifted paths</summary>", "");
      for (const entry of drift.driftPaths) {
        const bad = (drift.disallowedPaths ?? []).includes(entry);
        lines.push(`- ${bad ? "❌" : "✅"} \`${entry}\``);
      }
      lines.push("", "</details>");
    }
  }

  if ((payload?.verdicts ?? []).length > 0) {
    lines.push("", "### Signed verdicts", "");
    lines.push("| Subject | Verdict | Notes |", "| --- | --- | --- |");
    for (const verdict of payload.verdicts) {
      lines.push(
        `| \`${escapeCell(verdict.subject)}\` | ${VERDICT_ICONS[verdict.verdict] ?? ""} ${escapeCell(verdict.verdict)} | ${escapeCell(verdict.notes ?? "")} |`,
      );
    }
  }

  const failures = report?.failures ?? [];
  if (failures.length > 0) {
    lines.push("", "### Verification failures", "");
    for (const failure of failures) {
      lines.push(`- \`${failure.code}\`: ${failure.message}`);
    }
  }
  if (report === undefined) {
    lines.push(
      "",
      "### Verification failures",
      "",
      "- verify report missing — `certify:verify` did not produce output; see the job log",
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderAnnotations({ report, drift }) {
  const lines = [];
  for (const failure of report?.failures ?? []) {
    lines.push(
      `::error title=certification-verify (${failure.code})::${failure.message}`,
    );
  }
  if (report === undefined) {
    lines.push(
      "::error title=certification-verify::certify:verify produced no report; see the job log",
    );
  }
  if (
    drift !== undefined &&
    drift.result !== "match" &&
    drift.result !== "allowed-drift"
  ) {
    lines.push(
      `::error title=certification-verify (${drift.result})::${drift.detail}`,
    );
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        console.error(`${flag} requires a value`);
        process.exit(2);
      }
      index += 1;
      return next;
    };
    if (flag === "--report") args.reportPath = value();
    else if (flag === "--drift") args.driftPath = value();
    else if (flag === "--pubkey") args.pubkeyPath = value();
    else if (flag === "--cert-path") args.certPath = value();
    else if (flag === "--mode") args.mode = value();
    else {
      console.error(`unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  if (args.mode !== "summary" && args.mode !== "annotations") {
    console.error(
      "Usage: render-check-summary.mjs --mode <summary|annotations> --report <verify.json> --drift <drift.json> --pubkey <pem> --cert-path <display path>",
    );
    process.exit(2);
  }

  const report = readJsonIfPossible(args.reportPath);
  const drift = readJsonIfPossible(args.driftPath);
  let trustedFingerprint = "unavailable";
  if (args.pubkeyPath !== undefined) {
    try {
      trustedFingerprint = fingerprintPem(
        readFileSync(args.pubkeyPath, "utf8"),
      );
    } catch {
      trustedFingerprint = "unreadable public key";
    }
  }

  const output =
    args.mode === "summary"
      ? renderSummary({
          report,
          drift,
          trustedFingerprint,
          certPath: args.certPath ?? "certification.json",
        })
      : renderAnnotations({ report, drift });
  if (output.length > 0) process.stdout.write(`${output}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
