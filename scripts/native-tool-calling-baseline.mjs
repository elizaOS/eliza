#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  "research/native-tool-calling/baseline.json",
);

const SOURCE_ROOTS = ["packages", "plugins", "cloud"];
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const EXCLUDED_DIRS = new Set([
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
]);

const TOON_INVENTORY_REGEX_SOURCE =
  "TOON|toon|parseToon|tryParseToon|encodeToon|formatToon|preferredEncapsulation:\\s*[\\\"']toon|Output TOON";
const TOON_INVENTORY_REGEX = new RegExp(
  "TOON|toon|parseToon|tryParseToon|encodeToon|formatToon|preferredEncapsulation:\\s*[\"']toon|Output TOON",
  "g",
);

const ACTION_DECLARATION_PATTERNS = [
  /\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*Action\b/g,
  /\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]+?\bsatisfies\s+Action\b/g,
  /\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]+?\bas\s+Action\b/g,
];

const PROVIDER_DECLARATION_PATTERNS = [
  /\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*Provider\b/g,
  /\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]+?\bsatisfies\s+Provider\b/g,
  /\b(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]+?\bas\s+Provider\b/g,
];

const ACTION_PATH_PATTERN = /(^|\/)actions?(\/|\.|$)|(^|\/)[A-Za-z0-9_-]*actions?\.[cm]?[jt]sx?$/;
const PROVIDER_PATH_PATTERN =
  /(^|\/)providers?(\/|\.|$)|(^|\/)[A-Za-z0-9_-]*providers?\.[cm]?[jt]sx?$/;

function usage() {
  return [
    "Usage: node scripts/native-tool-calling-baseline.mjs [--stdout] [--output <path>]",
    "",
    "Writes research/native-tool-calling/baseline.json by default.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { stdout: false, outputPath: OUTPUT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stdout") {
      args.stdout = true;
      continue;
    }
    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) throw new Error("--output requires a path");
      args.outputPath = path.resolve(REPO_ROOT, value);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function toRepoRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function hasExcludedSegment(relativePath) {
  return relativePath
    .split("/")
    .some((segment) => EXCLUDED_DIRS.has(segment));
}

function listFiles({ sourceOnly = false } = {}) {
  const gitFiles = getGitOutput([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...SOURCE_ROOTS,
  ]);

  if (gitFiles) {
    return gitFiles
      .split("\0")
      .filter(Boolean)
      .filter((file) => !hasExcludedSegment(file))
      .filter((file) => {
        const absolutePath = path.join(REPO_ROOT, file);
        return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
      })
      .filter((file) => !sourceOnly || isSourceFile(file))
      .sort((a, b) => a.localeCompare(b));
  }

  const files = [];
  const stack = SOURCE_ROOTS.map((root) => path.join(REPO_ROOT, root)).filter(
    (root) => fs.existsSync(root),
  );

  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && (!sourceOnly || isSourceFile(fullPath))) {
        files.push(toRepoRelative(fullPath));
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function listSourceFiles() {
  return listFiles({ sourceOnly: true });
}

function isLikelyBinary(buffer) {
  return buffer.includes(0);
}

function countPatternMatches(text, regex) {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(text) !== null) count += 1;
  return count;
}

function countDeclarationMatches(text, patterns) {
  return patterns.reduce(
    (sum, pattern) => sum + countPatternMatches(text, pattern),
    0,
  );
}

function familyForPath(relativePath) {
  const parts = relativePath.split("/");
  if (parts[0] === "plugins" && parts[1]) return `plugins/${parts[1]}`;
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === "cloud" && parts[1] && parts[2]) {
    return `cloud/${parts[1]}/${parts[2]}`;
  }
  if (parts[0] === "cloud" && parts[1]) return `cloud/${parts[1]}`;
  return parts[0] || "unknown";
}

function makeEmptyFamilyStats() {
  return {
    actionFiles: 0,
    roughActionDeclarations: 0,
    providerFiles: 0,
    roughProviderDeclarations: 0,
  };
}

function inventoryToonFiles(files) {
  const ripgrepInventory = inventoryToonFilesWithRipgrep();
  if (ripgrepInventory) return ripgrepInventory;

  const toonFiles = [];
  let toonMatches = 0;

  for (const relativePath of files) {
    const buffer = fs.readFileSync(path.join(REPO_ROOT, relativePath));
    if (isLikelyBinary(buffer)) continue;

    const text = buffer.toString("utf8");
    const fileToonMatches = countPatternMatches(text, TOON_INVENTORY_REGEX);
    if (fileToonMatches > 0) {
      toonFiles.push(relativePath);
      toonMatches += fileToonMatches;
    }
  }

  return {
    commandFromPlan:
      'rg -n "TOON|toon|parseToon|tryParseToon|encodeToon|formatToon|preferredEncapsulation:\\\\s*[\\"\\\']toon|Output TOON" packages plugins cloud --glob \'!**/node_modules/**\' --glob \'!**/dist/**\' --glob \'!**/build/**\' --glob \'!**/generated/**\'',
    regexSource: TOON_INVENTORY_REGEX_SOURCE,
    method: "node-fallback",
    scannedRoots: SOURCE_ROOTS,
    excludedDirectories: [...EXCLUDED_DIRS].sort((a, b) => a.localeCompare(b)),
    fileCount: toonFiles.length,
    matchCount: toonMatches,
  };
}

function inventoryToonFilesWithRipgrep() {
  const args = [
    "--count-matches",
    TOON_INVENTORY_REGEX_SOURCE,
    ...SOURCE_ROOTS,
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/build/**",
    "--glob",
    "!**/generated/**",
    "--glob",
    "!**/.turbo/**",
    "--glob",
    "!**/coverage/**",
  ];

  let output = "";
  try {
    output = execFileSync("rg", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status === 1) output = error.stdout || "";
    else return null;
  }

  const rows = output.trim() ? output.trim().split("\n") : [];
  let matchCount = 0;
  for (const row of rows) {
    const separator = row.lastIndexOf(":");
    if (separator === -1) continue;
    matchCount += Number(row.slice(separator + 1)) || 0;
  }

  return {
    commandFromPlan:
      'rg -n "TOON|toon|parseToon|tryParseToon|encodeToon|formatToon|preferredEncapsulation:\\\\s*[\\"\\\']toon|Output TOON" packages plugins cloud --glob \'!**/node_modules/**\' --glob \'!**/dist/**\' --glob \'!**/build/**\' --glob \'!**/generated/**\'',
    regexSource: TOON_INVENTORY_REGEX_SOURCE,
    method: "rg --count-matches",
    scannedRoots: SOURCE_ROOTS,
    excludedDirectories: [...EXCLUDED_DIRS].sort((a, b) => a.localeCompare(b)),
    fileCount: rows.length,
    matchCount,
  };
}

function inventoryActionAndProviderFiles(files) {
  const families = new Map();
  let actionFiles = 0;
  let actionDeclarations = 0;
  let providerFiles = 0;
  let providerDeclarations = 0;
  let cacheStableAnnotations = 0;

  for (const relativePath of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const family = familyForPath(relativePath);
    const familyStats = families.get(family) ?? makeEmptyFamilyStats();

    const fileActionDeclarations = countDeclarationMatches(
      text,
      ACTION_DECLARATION_PATTERNS,
    );
    const isActionFile =
      ACTION_PATH_PATTERN.test(relativePath) || fileActionDeclarations > 0;
    if (isActionFile) {
      actionFiles += 1;
      familyStats.actionFiles += 1;
    }
    if (fileActionDeclarations > 0) {
      actionDeclarations += fileActionDeclarations;
      familyStats.roughActionDeclarations += fileActionDeclarations;
    }

    const fileProviderDeclarations = countDeclarationMatches(
      text,
      PROVIDER_DECLARATION_PATTERNS,
    );
    const isProviderFile =
      PROVIDER_PATH_PATTERN.test(relativePath) || fileProviderDeclarations > 0;
    if (isProviderFile) {
      providerFiles += 1;
      familyStats.providerFiles += 1;
    }
    if (fileProviderDeclarations > 0) {
      providerDeclarations += fileProviderDeclarations;
      familyStats.roughProviderDeclarations += fileProviderDeclarations;
    }

    cacheStableAnnotations += countPatternMatches(text, /\bcacheStable\s*:/g);
    families.set(family, familyStats);
  }

  return {
    actions: {
      fileCount: actionFiles,
      roughDeclarationCount: actionDeclarations,
      byFamily: Object.fromEntries(
        [...families.entries()]
          .filter(([, stats]) => stats.actionFiles > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([family, stats]) => [
            family,
            {
              fileCount: stats.actionFiles,
              roughDeclarationCount: stats.roughActionDeclarations,
            },
          ]),
      ),
    },
    providers: {
      fileCount: providerFiles,
      roughDeclarationCount: providerDeclarations,
      cacheStableAnnotationCount: cacheStableAnnotations,
      byFamily: Object.fromEntries(
        [...families.entries()]
          .filter(([, stats]) => stats.providerFiles > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([family, stats]) => [
            family,
            {
              fileCount: stats.providerFiles,
              roughDeclarationCount: stats.roughProviderDeclarations,
            },
          ]),
      ),
    },
  };
}

function getGitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return "";
  }
}

function getDirtyFiles() {
  const output = getGitOutput(["status", "--porcelain=v1", "-z"]);
  if (!output) return [];
  const entries = output.split("\0").filter(Boolean);
  const dirtyFiles = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const destination = entries[i + 1];
      if (destination) {
        dirtyFiles.push({ status, path: destination, originalPath: file });
        i += 1;
      } else {
        dirtyFiles.push({ status, path: file });
      }
      continue;
    }
    dirtyFiles.push({ status, path: file });
  }

  return dirtyFiles.sort((a, b) => a.path.localeCompare(b.path));
}

function getGitHead() {
  const commit = getGitOutput(["rev-parse", "HEAD"]).trim();
  const branch = getGitOutput(["branch", "--show-current"]).trim();
  return { branch, commit };
}

function isIgnored(relativePath) {
  try {
    execFileSync("git", ["check-ignore", "-q", relativePath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function buildBaseline() {
  const allFiles = listFiles();
  const sourceFiles = listSourceFiles();
  return {
    schemaVersion: 1,
    plan: "research/native-tool-calling/PLAN.md",
    git: {
      ...getGitHead(),
      dirtyFiles: getDirtyFiles(),
    },
    inventory: {
      scannedFileCount: allFiles.length,
      sourceFileCount: sourceFiles.length,
      toon: inventoryToonFiles(allFiles),
      ...inventoryActionAndProviderFiles(sourceFiles),
    },
    expensiveVerifyPlaceholders: [
      {
        command: "bun run verify",
        status: "not_run",
        reason:
          "Full verify is intentionally left as a placeholder for this baseline script because it can be expensive and environment-dependent.",
      },
      {
        command: "cache benchmark cold run on 5 representative scenarios",
        status: "not_run",
        reason:
          "Scenario selection and model/provider credentials are outside this deterministic inventory script.",
      },
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = buildBaseline();
  const json = `${JSON.stringify(baseline, null, 2)}\n`;

  if (!args.stdout) {
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, json);
  }

  const outputRelativePath = toRepoRelative(args.outputPath);
  const tracked = getGitOutput(["ls-files", "--", outputRelativePath]).trim();
  const ignored = isIgnored(outputRelativePath);

  console.log(
    [
      `Native tool calling baseline${args.stdout ? "" : ` written to ${outputRelativePath}`}`,
      `TOON inventory: ${baseline.inventory.toon.fileCount} files, ${baseline.inventory.toon.matchCount} matches`,
      `Actions: ${baseline.inventory.actions.fileCount} files, ${baseline.inventory.actions.roughDeclarationCount} rough declarations`,
      `Providers: ${baseline.inventory.providers.fileCount} files, ${baseline.inventory.providers.roughDeclarationCount} rough declarations`,
      `Dirty files: ${baseline.git.dirtyFiles.length}`,
      `Baseline JSON tracked: ${tracked ? "yes" : "no"}, ignored: ${ignored ? "yes" : "no"}`,
    ].join("\n"),
  );

  if (args.stdout) console.log(json);
}

main();
