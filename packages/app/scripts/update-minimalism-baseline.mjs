#!/usr/bin/env bun
/**
 * update-minimalism-baseline — regenerate the committed "Her"-minimal ratchet
 * baseline (#9950) from the latest all-views aesthetic audit report.
 *
 * Mirrors the `audit:ui-determinism:update` idiom: the baseline records the
 * CURRENT divider-density debt per slug+viewport so the audit gate blocks NEW
 * breaches and regressions while the backlog is burned down.
 *
 *   bun run --cwd packages/app audit:app:minimalism:update
 *   bun scripts/update-minimalism-baseline.mjs --report <report.json> --out <baseline.json>
 *
 * Runs under bun (it imports the TypeScript rules module directly).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMinimalismBaseline,
  MINIMALISM_DENSITY_CEILING,
} from "../test/ui-smoke/aesthetic-audit-rules.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value) {
    console.error(`[update-minimalism-baseline] ${flag} requires a path`);
    process.exit(1);
  }
  return value;
}

const reportPath = path.resolve(
  appDir,
  argValue("--report") ??
    path.join(
      process.env.ELIZA_AUDIT_APP_DIR ?? "aesthetic-audit-output",
      "report.json",
    ),
);
const outPath = path.resolve(
  appDir,
  argValue("--out") ?? "test/ui-smoke/aesthetic-minimalism-baseline.json",
);

let reportText;
try {
  reportText = readFileSync(reportPath, "utf8");
} catch {
  console.error(
    `[update-minimalism-baseline] no audit report at ${reportPath}\n` +
      `Run the audit first: bun run --cwd packages/app audit:app`,
  );
  process.exit(1);
}

const findings = JSON.parse(reportText);
if (!Array.isArray(findings) || findings.length === 0) {
  console.error(
    `[update-minimalism-baseline] ${reportPath} is not a non-empty findings array — refusing to write an empty baseline from a bad report`,
  );
  process.exit(1);
}
for (const finding of findings) {
  for (const field of [
    "slug",
    "viewport",
    "viewType",
    "borderDividerDensity",
    "textDensity",
    "whitespaceRatio",
  ]) {
    if (!(field in finding)) {
      console.error(
        `[update-minimalism-baseline] report finding missing \`${field}\` — is ${reportPath} from the current audit spec?`,
      );
      process.exit(1);
    }
  }
}

const baseline = buildMinimalismBaseline(findings, new Date().toISOString());
writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
console.log(
  `[update-minimalism-baseline] recorded ${
    Object.keys(baseline.views).length
  } breaching view/viewport combos (of ${findings.length} findings, ceiling ${MINIMALISM_DENSITY_CEILING}/Mpx²) → ${outPath}`,
);
