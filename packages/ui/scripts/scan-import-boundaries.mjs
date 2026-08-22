/**
 * Ratchets dependencies between the design system, client, cloud console, and
 * app shell while those domains are extracted into separate packages.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "src");
const baselinePath = resolve(
  packageRoot,
  "scripts/import-boundary-baseline.json",
);
const updateBaseline = process.argv.includes("--update-baseline");

const rules = [
  {
    name: "design-system-is-browser-agnostic",
    owners: ["components/ui/", "components/primitives/", "styles/"],
    forbidden: ["api/", "bridge/", "cloud/", "cloud-ui/", "state/", "App.tsx"],
  },
  {
    name: "ui-client-does-not-render-features",
    owners: ["api/"],
    forbidden: [
      "components/pages/",
      "components/shell/",
      "cloud-ui/",
      "App.tsx",
    ],
  },
  {
    name: "cloud-ui-does-not-own-the-app-shell",
    owners: ["cloud-ui/"],
    forbidden: ["components/shell/", "App.tsx"],
  },
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(path);
      return [path];
    }),
  );
  return nested.flat();
}

function sourcePath(path) {
  return relative(sourceRoot, path).split(sep).join("/");
}

function resolveImport(importer, specifier) {
  if (specifier.startsWith(".")) {
    return sourcePath(resolve(dirname(importer), specifier));
  }
  if (specifier === "@elizaos/ui") return "index.ts";
  if (specifier.startsWith("@elizaos/ui/")) {
    return specifier.slice("@elizaos/ui/".length);
  }
  return null;
}

const files = (await collectFiles(sourceRoot)).filter((path) =>
  [".ts", ".tsx"].includes(extname(path)),
);
const violations = [];
const importPattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu;

for (const file of files) {
  const owner = sourcePath(file);
  const source = await readFile(file, "utf8");
  for (const rule of rules) {
    if (!rule.owners.some((prefix) => owner.startsWith(prefix))) continue;
    for (const match of source.matchAll(importPattern)) {
      const target = resolveImport(file, match[1]);
      if (!target) continue;
      const forbidden = rule.forbidden.find(
        (prefix) => target === prefix || target.startsWith(prefix),
      );
      if (forbidden) {
        violations.push({ rule: rule.name, file: owner, target });
      }
    }
  }
}

violations.sort((left, right) =>
  `${left.rule}:${left.file}:${left.target}`.localeCompare(
    `${right.rule}:${right.file}:${right.target}`,
  ),
);
const counts = Object.fromEntries(
  rules.map((rule) => [
    rule.name,
    violations.filter((violation) => violation.rule === rule.name).length,
  ]),
);
const report = { counts, violations };

if (updateBaseline) {
  await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Updated import-boundary baseline (${violations.length} violations).`,
  );
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const regressions = rules.filter(
  (rule) => counts[rule.name] > (baseline.counts[rule.name] ?? 0),
);
if (regressions.length > 0) {
  throw new Error(
    `Import boundaries regressed:\n${regressions
      .map(
        (rule) =>
          `- ${rule.name}: ${baseline.counts[rule.name] ?? 0} -> ${counts[rule.name]}`,
      )
      .join("\n")}`,
  );
}

console.log(
  `Import boundaries match or improve on baseline (${violations.length} remaining violations).`,
);
