// Drives repo automation audit capability router naming with explicit CLI and CI behavior.
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

// Migration is complete: the codebase uses the remote-plugin vocabulary.
// This audit guards against the old satellite/carrot vocabulary creeping
// back into source/docs/workflows. A few historical-analysis docs are
// allowlisted because they intentionally discuss the old terminology.
const allowedLegacyMentions = new Map<string, RegExp[]>([
  [
    "packages/agent/docs/capability-router-remote-plugins.md",
    [/satellite/i, /carrot/i],
  ],
]);

const legacyPattern = /\b(?:satellite|carrot)\b/i;
const failures: string[] = [];

for (const root of auditedRoots) {
  for (const file of walk(root)) {
    const source = readFileSync(file, "utf8");
    const allowlist = allowedLegacyMentions.get(file) ?? [];
    for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
      if (!legacyPattern.test(line)) continue;
      if (allowlist.some((pattern) => pattern.test(line))) continue;
      failures.push(
        `${file}:${lineIndex + 1}: legacy "satellite"/"carrot" vocabulary is forbidden; use remote-plugin / capability-router terminology.`,
      );
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
      allowedLegacyMentionFiles: [...allowedLegacyMentions.keys()],
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
