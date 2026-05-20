#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const removedPackage = ["@elizaos/plugin", "smartglasses"].join("-");
const removedWorkspace = ["plugins/plugin", "smartglasses"].join("-");
const removedRegistryEntry = [
  "packages/app-core/src/registry/entries/plugins",
  "smartglasses.json",
].join("/");
const removedRegistryTest = ["smartglasses", "registry"].join("-");
const facewearPackage = "@elizaos/plugin-facewear";
const facewearWorkspace = "plugins/plugin-facewear";

const requiredFiles = [
  "package.json",
  "packages/app/package.json",
  "packages/examples/smartglasses/package.json",
  "bun.lock",
];
const scanRoots = ["packages", "plugins", "apps", "scripts"];
const textExtensions = new Set([
  ".css",
  ".gradle",
  ".html",
  ".java",
  ".js",
  ".json",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".properties",
  ".py",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);
const ignoredDirectories = new Set([
  ".git",
  ".gradle",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

if (process.argv.includes("--fix-lock")) {
  const lockPath = "bun.lock";
  const before = read(lockPath);
  const after = repairFacewearLockfileSource(before);
  if (after !== before) writeFileSync(resolve(repoRoot, lockPath), after);
  const failures = [
    ...staleReferenceFailures(lockPath, after),
    ...facewearLockInvariantFailures(after),
  ];
  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, fixed: after !== before, failures }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, fixed: after !== before, lockfile: lockPath }, null, 2));
  process.exit(0);
}

const failures = [];
const scannedFiles = [];

for (const relPath of requiredFiles) {
  checkSourceFile(relPath);
}

for (const root of scanRoots) {
  scanDirectory(resolve(repoRoot, root));
}

function checkSourceFile(relPath) {
  if (scannedFiles.includes(relPath)) return;
  const source = read(relPath);
  scannedFiles.push(relPath);
  failures.push(...staleReferenceFailures(relPath, source));
}

failures.push(
  ...removedPathFailures((relPath) => existsSync(resolve(repoRoot, relPath))),
);

const appPackage = read("packages/app/package.json");
const examplePackage = read("packages/examples/smartglasses/package.json");
const lockfile = read("bun.lock");

if (!appPackage.includes(`"${facewearPackage}": "workspace:*"`)) {
  failures.push(`packages/app/package.json: missing ${facewearPackage}`);
}

if (!examplePackage.includes(`"${facewearPackage}": "workspace:*"`)) {
  failures.push(
    `packages/examples/smartglasses/package.json: missing ${facewearPackage}`,
  );
}

failures.push(...facewearLockInvariantFailures(lockfile));

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      package: facewearPackage,
      workspace: facewearWorkspace,
      checkedFiles: scannedFiles.length,
      checkedRoots: scanRoots,
    },
    null,
    2,
  ),
);

function scanDirectory(absPath) {
  if (!existsSync(absPath)) return;
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    const child = join(absPath, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) scanDirectory(child);
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    checkSourceFile(relative(repoRoot, child));
  }
}

function isTextFile(fileName) {
  if (fileName === "package.json") return true;
  return textExtensions.has(extname(fileName));
}

function read(relPath) {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function staleReferenceFailures(relPath, source) {
  const result = [];
  if (source.includes(removedPackage)) {
    result.push(`${relPath}: still references ${removedPackage}`);
  }
  if (source.includes(removedWorkspace)) {
    result.push(`${relPath}: still references ${removedWorkspace}`);
  }
  if (source.includes(removedRegistryTest)) {
    result.push(`${relPath}: still references removed registry test`);
  }
  if (source.includes(removedRegistryEntry)) {
    result.push(`${relPath}: still references removed registry entry`);
  }
  return result;
}

function removedPathFailures(pathExists) {
  const result = [];
  if (pathExists(removedWorkspace)) {
    result.push(`${removedWorkspace}: removed workspace still exists`);
  }
  if (pathExists(removedRegistryEntry)) {
    result.push(`${removedRegistryEntry}: removed registry entry still exists`);
  }
  return result;
}

function facewearLockInvariantFailures(lockfileSource) {
  const result = [];
  if (!lockfileSource.includes(`"${facewearWorkspace}": {`)) {
    result.push(`bun.lock: missing ${facewearWorkspace} workspace block`);
  }
  if (!lockfileSource.includes(`"${facewearPackage}": [`)) {
    result.push(`bun.lock: missing ${facewearPackage} package map entry`);
  }
  if (!lockfileSource.includes('"ws": "^8.18.0"')) {
    result.push("bun.lock: facewear workspace block is missing ws dependency");
  }
  if (!lockfileSource.includes('"@types/ws": "^8.5.10"')) {
    result.push(
      "bun.lock: facewear workspace block is missing @types/ws dev dependency",
    );
  }
  return result;
}

function repairFacewearLockfileSource(source) {
  let next = source
    .replaceAll(`"${removedPackage}": "workspace:*"`, `"${facewearPackage}": "workspace:*"`)
    .replaceAll(`"${removedWorkspace}": {`, `"${facewearWorkspace}": {`)
    .replaceAll(`"name": "${removedPackage}"`, `"name": "${facewearPackage}"`)
    .replaceAll(
      `"${removedPackage}": ["${removedPackage}@workspace:${removedWorkspace}"]`,
      `"${facewearPackage}": ["${facewearPackage}@workspace:${facewearWorkspace}"]`,
    );

  next = replaceFacewearWorkspaceVersion(next);
  next = ensureFacewearWorkspaceDependency(next, "lucide-react", '"ws": "^8.18.0"');
  next = ensureFacewearWorkspaceDependency(next, "ws", '"zod": "^4.4.3"');
  next = ensureFacewearWorkspaceDependency(next, "@types/react-dom", '"@types/ws": "^8.5.10"');
  return next;
}

function replaceFacewearWorkspaceVersion(source) {
  const marker = `"${facewearWorkspace}": {`;
  const start = source.indexOf(marker);
  if (start < 0) return source;
  const nextWorkspace = source.indexOf('\n    "plugins/', start + marker.length);
  const end = nextWorkspace < 0 ? source.length : nextWorkspace;
  const block = source.slice(start, end);
  const repaired = block.replace('"version": "2.0.0-beta.2"', '"version": "0.1.0"');
  return `${source.slice(0, start)}${repaired}${source.slice(end)}`;
}

function ensureFacewearWorkspaceDependency(source, afterDependencyName, dependencyLine) {
  const marker = `"${facewearWorkspace}": {`;
  const start = source.indexOf(marker);
  if (start < 0) return source;
  const nextWorkspace = source.indexOf('\n    "plugins/', start + marker.length);
  const end = nextWorkspace < 0 ? source.length : nextWorkspace;
  const block = source.slice(start, end);
  if (block.includes(dependencyLine)) return source;
  const afterLine = `        "${afterDependencyName}": `;
  const lineStart = block.indexOf(afterLine);
  if (lineStart < 0) return source;
  const lineEnd = block.indexOf("\n", lineStart);
  if (lineEnd < 0) return source;
  const repaired = `${block.slice(0, lineEnd + 1)}        ${dependencyLine},\n${block.slice(lineEnd + 1)}`;
  return `${source.slice(0, start)}${repaired}${source.slice(end)}`;
}

function runSelfTest() {
  const fixtures = [
    {
      name: "removed package",
      relPath: "package.json",
      source: `"${removedPackage}": "workspace:*"`,
      expected: removedPackage,
    },
    {
      name: "removed workspace",
      relPath: "bun.lock",
      source: `"${removedWorkspace}": {}`,
      expected: removedWorkspace,
    },
    {
      name: "removed registry entry",
      relPath: "docs.md",
      source: removedRegistryEntry,
      expected: "removed registry entry",
    },
    {
      name: "removed registry test",
      relPath: "test.ts",
      source: removedRegistryTest,
      expected: "removed registry test",
    },
  ];
  const failures = [];
  for (const fixture of fixtures) {
    const detected = staleReferenceFailures(fixture.relPath, fixture.source);
    if (!detected.some((failure) => failure.includes(fixture.expected))) {
      failures.push(`${fixture.name}: expected ${fixture.expected}`);
    }
  }

  const clean = staleReferenceFailures(
    "package.json",
    `"${facewearPackage}": "workspace:*"\n"${facewearWorkspace}": {}`,
  );
  if (clean.length > 0) failures.push(`clean facewear fixture failed: ${clean}`);

  const pathFailures = removedPathFailures((relPath) =>
    relPath === removedWorkspace || relPath === removedRegistryEntry,
  );
  for (const expected of ["removed workspace", "removed registry entry"]) {
    if (!pathFailures.some((failure) => failure.includes(expected))) {
      failures.push(`removed path fixture missing ${expected}`);
    }
  }
  const cleanPathFailures = removedPathFailures(() => false);
  if (cleanPathFailures.length > 0) {
    failures.push(`clean path fixture failed: ${cleanPathFailures}`);
  }

  const lockFixture = [
    `"${facewearWorkspace}": {`,
    `  "name": "${facewearPackage}",`,
    '  "version": "0.1.0",',
    '  "dependencies": {',
    '        "lucide-react": "^1.0.0",',
    '        "ws": "^8.18.0"',
    '        "zod": "^4.4.3"',
    "  },",
    '  "devDependencies": {',
    '        "@types/react-dom": "^19.2.3",',
    '        "@types/ws": "^8.5.10"',
    "  }",
    "},",
    `"${facewearPackage}": ["${facewearPackage}@workspace:${facewearWorkspace}"]`,
  ].join("\n");
  const lockFailures = facewearLockInvariantFailures(lockFixture);
  if (lockFailures.length > 0) {
    failures.push(`valid facewear lock fixture failed: ${lockFailures}`);
  }

  const brokenLockFixtures = [
    {
      name: "missing workspace block",
      source: lockFixture.replace(`"${facewearWorkspace}": {`, '"other": {'),
      expected: "workspace block",
    },
    {
      name: "missing package map",
      source: lockFixture.replace(`"${facewearPackage}": [`, '"other": ['),
      expected: "package map",
    },
    {
      name: "missing ws",
      source: lockFixture.replace('    "ws": "^8.18.0"', ""),
      expected: "ws dependency",
    },
    {
      name: "missing @types/ws",
      source: lockFixture.replace('    "@types/ws": "^8.5.10"', ""),
      expected: "@types/ws dev dependency",
    },
  ];
  for (const fixture of brokenLockFixtures) {
    const detected = facewearLockInvariantFailures(fixture.source);
    if (!detected.some((failure) => failure.includes(fixture.expected))) {
      failures.push(`${fixture.name}: expected ${fixture.expected}`);
    }
  }

  const staleLockFixture = lockFixture
    .replaceAll(facewearPackage, removedPackage)
    .replaceAll(facewearWorkspace, removedWorkspace)
    .replace('"version": "0.1.0"', '"version": "2.0.0-beta.2"')
    .replace('    "ws": "^8.18.0"', "")
    .replace('    "zod": "^4.4.3"', "")
    .replace('    "@types/ws": "^8.5.10"', "");
  const repairedLock = repairFacewearLockfileSource(staleLockFixture);
  const repairFailures = [
    ...staleReferenceFailures("bun.lock", repairedLock),
    ...facewearLockInvariantFailures(repairedLock),
  ];
  if (repairFailures.length > 0) {
    failures.push(`repair stale lock fixture failed: ${repairFailures}`);
  }
  if (!repairedLock.includes('"version": "0.1.0"')) {
    failures.push("repair stale lock fixture did not restore facewear version");
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        fixtures: fixtures.length + brokenLockFixtures.length + 4,
      },
      null,
      2,
    ),
  );
}
