import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const auditedRoots = [
  ".github",
  "docs",
  "packages/agent/src",
  "packages/app/src",
  "packages/app-core/src",
  "packages/core/src",
  "packages/elizaos/src",
  "packages/shared/src",
];

const allowedSatelliteMentions = new Map<string, RegExp[]>([
  [
    "packages/agent/src/services/remote-capability-router.ts",
    [/ELIZA_SATELLITE_RUNNER_URL/, /ELIZA_SATELLITE_RUNNER_TOKEN/],
  ],
  [
    "packages/agent/src/services/remote-capability-router.test.ts",
    [
      /resolves canonical env names before legacy satellite aliases/,
      /ELIZA_SATELLITE_RUNNER_URL/,
      /ELIZA_SATELLITE_RUNNER_TOKEN/,
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
        `${file}:${lineIndex + 1}: use capability-router/remote-capability vocabulary; satellite is only allowed for legacy env aliases.`,
      );
    }
  }
}

for (const file of allowedSatelliteMentions.keys()) {
  if (!statExists(file)) {
    failures.push(`Allowlisted satellite file is missing: ${file}`);
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
      legacySatelliteAllowlistFiles: [...allowedSatelliteMentions.keys()],
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
