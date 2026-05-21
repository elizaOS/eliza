import { readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

const defaultAuditedRoots = [
  ".github",
  "docs",
  "packages/agent/docs",
  "packages/agent/src",
  "packages/app/src",
  "packages/app-core/src",
  "packages/core/src",
  "packages/elizaos/src",
  "packages/shared/src",
];
const auditedRoots =
  process.env.CAPABILITY_ROUTER_NAMING_AUDIT_ROOTS?.split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean) ?? defaultAuditedRoots;

const allowedSatelliteMentions = new Map<string, RegExp[]>([
  [
    "packages/agent/docs/capability-router-remote-plugins.md",
    [
      /A satellite is one possible/,
      /## Why Not "Satellite" As The Abstraction/,
      /PR #7779 uses the word "satellite"/,
      /non-satellite cases/,
      /whether or not the provider is called a satellite/,
      /Keep `satellite` for a concrete deployment target/,
      /It only allows `satellite` in this historical naming analysis/,
      /"Satellite" is overloaded/,
      /E2B\/Satellite/,
      /defines a Satellite HTTP/,
      /coding-satellite/,
      /plugins mean things, satellites/,
      /Electrobun satellites as one deployment backend/,
      /There is no current E2B, home-machine, mobile-companion, or coding-satellite/,
      /source\/docs\/workflow roots reintroduce `satellite`/,
      /without reintroducing satellite-specific runtime code/,
      /do not use `satellite` as canonical runtime/,
      /ELIZA_SATELLITE_RUNNER_\*/,
      /Canonical abstraction is not `satellite`/,
      /The old satellite-specific names/,
    ],
  ],
]);

const satellitePattern = /satellite/i;
const failures: string[] = [];

for (const root of auditedRoots) {
  for (const file of walk(root)) {
    const source = readFileSync(file, "utf8");
    const allowlist = allowedSatelliteMentions.get(file) ?? [];
    for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
      if (!satellitePattern.test(line)) continue;
      if (allowlist.some((pattern) => pattern.test(line))) continue;
      failures.push(
        `${file}:${lineIndex + 1}: use capability-router/remote-capability vocabulary; satellite is only allowed for historical naming analysis.`,
      );
    }
  }
}

if (!process.env.CAPABILITY_ROUTER_NAMING_AUDIT_ROOTS) {
  for (const [file, patterns] of allowedSatelliteMentions.entries()) {
    if (!statExists(file)) {
      failures.push(`Allowlisted satellite file is missing: ${file}`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (!pattern.test(source)) {
        failures.push(
          `Allowlisted satellite pattern no longer matches ${file}: ${pattern}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("[capability-router-naming-audit] failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      auditedRoots,
      allowedSatelliteMentionFiles: [...allowedSatelliteMentions.keys()],
    },
    null,
    2,
  ),
);

function* walk(path: string): Generator<string> {
  if (!statExists(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (isAuditedFile(path)) yield path;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path).sort()) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }
    yield* walk(join(path, entry));
  }
}

function isAuditedFile(path: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/.test(path);
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
