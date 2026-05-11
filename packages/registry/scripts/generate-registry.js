#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REGISTRY_ROOT = path.resolve(__dirname, "..");
const ELIZA_REPO_ROOT = path.resolve(
  process.env.ELIZA_REPO_ROOT || path.join(REGISTRY_ROOT, "..", ".."),
);
const BUILTIN_REPO = process.env.ELIZA_BUILTIN_REPO || "elizaos/eliza";
const BUILTIN_BRANCH = process.env.ELIZA_BUILTIN_BRANCH || "main";
const SCHEMA_VERSION = "registry-v2";

const OUTPUT_FILES = {
  generated: path.join(REGISTRY_ROOT, "generated-registry.json"),
  index: path.join(REGISTRY_ROOT, "index.json"),
  summary: path.join(REGISTRY_ROOT, "registry-summary.json"),
};

const THIRD_PARTY_DIR = path.join(REGISTRY_ROOT, "entries", "third-party");
const APP_CORE_ENTRIES_DIR = path.join(
  ELIZA_REPO_ROOT,
  "packages",
  "app-core",
  "src",
  "registry",
  "entries",
);
const PLUGINS_DIR = path.join(ELIZA_REPO_ROOT, "plugins");

const PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GITHUB_REPO_RE =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_DIRECTORY_RE = /^[A-Za-z0-9._/-]+$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const VALID_KINDS = new Set(["app", "connector", "plugin"]);

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function usage() {
  console.log(`Usage: node scripts/generate-registry.js [--check]

Generates the elizaOS plugin registry from:
  - ${path.relative(REGISTRY_ROOT, PLUGINS_DIR)}
  - entries/third-party/*.json

Environment:
  ELIZA_REPO_ROOT       Path to the eliza monorepo. Defaults to ../..
  ELIZA_BUILTIN_REPO   GitHub repo for built-ins. Defaults to elizaos/eliza
  ELIZA_BUILTIN_BRANCH Branch for built-in source links. Defaults to main`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function maybeReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function stableObject(entries) {
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.flat(Infinity)) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function npmLatestVersion(packageName) {
  if (process.env.ELIZA_REGISTRY_SKIP_NPM_LOOKUP === "1") {
    return null;
  }
  try {
    const output = execFileSync("npm", ["view", packageName, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function titleFromPackageName(packageName) {
  const shortName = packageName
    .replace(/^@[^/]+\//, "")
    .replace(/^(app|plugin)-/, "");
  return shortName
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function assertPackageName(packageName, context) {
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(`${context}: invalid npm package name "${packageName}"`);
  }
}

function assertGitHubRepo(repo, context) {
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new Error(`${context}: repository must be github:owner/repo`);
  }
}

function assertSafeDirectory(directory, context) {
  if (!directory) {
    return;
  }
  if (
    directory.startsWith("/") ||
    directory.includes("..") ||
    !SAFE_DIRECTORY_RE.test(directory)
  ) {
    throw new Error(`${context}: unsafe directory "${directory}"`);
  }
}

function normalizeGithubRepo(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  let input = value.trim();
  if (!input) {
    return null;
  }

  if (input.startsWith("github:")) {
    input = input.slice("github:".length);
  } else if (input.startsWith("git+")) {
    input = input.slice("git+".length);
  }

  input = input
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/tree\/.*$/, "")
    .replace(/\/blob\/.*$/, "")
    .replace(/#.*$/, "");

  const [owner, repo] = input.split("/");
  if (!owner || !repo) {
    return null;
  }
  return `${owner}/${repo}`;
}

function repositoryFromPackage(pkg) {
  if (!pkg || !pkg.repository) {
    return null;
  }
  if (typeof pkg.repository === "string") {
    return normalizeGithubRepo(pkg.repository);
  }
  if (typeof pkg.repository.url === "string") {
    return normalizeGithubRepo(pkg.repository.url);
  }
  return null;
}

function getCoreRange(pkg) {
  return (
    pkg.dependencies?.["@elizaos/core"] ||
    pkg.peerDependencies?.["@elizaos/core"] ||
    pkg.devDependencies?.["@elizaos/core"] ||
    null
  );
}

function findJsonFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

function loadAppCoreEntries() {
  const byPackage = new Map();
  for (const filePath of findJsonFiles(APP_CORE_ENTRIES_DIR)) {
    const entry = readJson(filePath);
    if (typeof entry.npmName === "string" && entry.npmName.trim()) {
      byPackage.set(entry.npmName.trim(), entry);
    }
  }
  return byPackage;
}

function packageDirs() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    throw new Error(`plugins directory not found: ${PLUGINS_DIR}`);
  }
  try {
    const tracked = execFileSync(
      "git",
      ["-C", ELIZA_REPO_ROOT, "ls-files", "plugins/*/package.json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((filePath) => path.dirname(filePath).split("/").pop())
      .filter(
        (dirName) =>
          dirName &&
          fs.existsSync(path.join(PLUGINS_DIR, dirName, "package.json")),
      );
    if (tracked.length > 0) {
      return [...new Set(tracked)].sort((left, right) =>
        left.localeCompare(right),
      );
    }
  } catch {
    // Non-git source trees still work by scanning plugins/ directly.
  }
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dirName) =>
      fs.existsSync(path.join(PLUGINS_DIR, dirName, "package.json")),
    )
    .sort((left, right) => left.localeCompare(right));
}

function readOptionalPluginManifest(pluginDir) {
  const manifestPath = path.join(PLUGINS_DIR, pluginDir, "elizaos.plugin.json");
  return maybeReadJson(manifestPath);
}

function deriveKind(pkg, manifest, appCoreEntry) {
  const candidates = [
    manifest?.kind,
    pkg.elizaos?.kind,
    appCoreEntry?.kind,
    pkg.elizaos?.app ? "app" : null,
    pkg.name?.includes("/app-") ? "app" : null,
  ];
  for (const candidate of candidates) {
    if (VALID_KINDS.has(candidate)) {
      return candidate;
    }
  }
  return "plugin";
}

function mapLaunchType(appCoreLaunchType) {
  switch (appCoreLaunchType) {
    case "internal-tab":
      return "local";
    case "overlay":
      return "overlay";
    case "server-launch":
      return "url";
    default:
      return "local";
  }
}

function normalizeAppMeta(packageName, pkg, manifest, appCoreEntry) {
  const packageApp = pkg.elizaos?.app || {};
  const manifestApp = manifest?.app || {};
  const appCoreLaunch = appCoreEntry?.launch || {};
  const appCoreRender = appCoreEntry?.render || {};
  const app = { ...packageApp, ...manifestApp };

  return {
    displayName:
      app.displayName || appCoreEntry?.name || titleFromPackageName(packageName),
    category: app.category || appCoreEntry?.subtype || "app",
    launchType: app.launchType || mapLaunchType(appCoreLaunch.type),
    launchUrl:
      app.launchUrl !== undefined
        ? app.launchUrl
        : appCoreLaunch.url !== undefined
          ? appCoreLaunch.url
          : null,
    icon: app.icon || appCoreRender.icon || null,
    heroImage: app.heroImage || appCoreRender.heroImage || null,
    capabilities: uniqueStrings([
      app.capabilities || [],
      appCoreLaunch.capabilities || [],
      appCoreEntry?.tags || [],
    ]),
    minPlayers: app.minPlayers ?? null,
    maxPlayers: app.maxPlayers ?? null,
    runtimePlugin: app.runtimePlugin || packageName,
    bridgeExport: app.bridgeExport || appCoreLaunch.routePlugin?.exportName,
    uiExtension: app.uiExtension || appCoreLaunch.uiExtension,
    viewer: app.viewer || appCoreLaunch.viewer,
    session: app.session || appCoreLaunch.session,
    developerOnly: app.developerOnly,
    visibleInAppStore: app.visibleInAppStore ?? appCoreRender.visible ?? true,
    mainTab: app.mainTab ?? appCoreLaunch.mainTab,
  };
}

function buildGeneratedEntry({
  packageName,
  repo,
  directory,
  version,
  coreRange,
  description,
  homepage,
  topics,
  kind,
  appMeta,
  origin,
  support,
  branch = "main",
}) {
  assertPackageName(packageName, packageName);
  assertGitHubRepo(repo, packageName);
  assertSafeDirectory(directory, packageName);

  const safeDescription = description || "";
  const safeVersion = version || null;

  const entry = {
    origin,
    source: origin,
    support,
    builtIn: origin === "builtin",
    firstParty: origin === "builtin",
    thirdParty: origin === "third-party",
    status: "active",
    kind,
    registryKind: kind,
    directory: directory || null,
    git: {
      repo,
      v0: { version: null, branch: null },
      v1: { version: null, branch: null },
      v2: { version: safeVersion, branch },
    },
    npm: {
      repo: packageName,
      v0: null,
      v1: null,
      v2: safeVersion,
      v0CoreRange: null,
      v1CoreRange: null,
      v2CoreRange: coreRange || null,
    },
    supports: { v0: false, v1: false, v2: true },
    description: safeDescription,
    homepage: homepage || null,
    topics: uniqueStrings(topics),
    stargazers_count: 0,
    language: "TypeScript",
  };

  if (appMeta) {
    entry.app = appMeta;
  }

  return entry;
}

function builtinEntryForPackage(pluginDir, pkg, manifest, appCoreEntry) {
  const packageName = pkg.name;
  assertPackageName(packageName, `plugins/${pluginDir}/package.json`);

  const kind = deriveKind(pkg, manifest, appCoreEntry);
  const directory = `plugins/${pluginDir}`;
  const repo = BUILTIN_REPO;
  const appMeta =
    kind === "app" ? normalizeAppMeta(packageName, pkg, manifest, appCoreEntry) : null;
  const homepage =
    pkg.homepage ||
    `https://github.com/${repo}/tree/${BUILTIN_BRANCH}/${directory}#readme`;
  const description =
    pkg.description || appCoreEntry?.description || titleFromPackageName(packageName);
  const topics = uniqueStrings([
    pkg.keywords || [],
    pkg.elizaos?.plugin?.capabilities || [],
    appCoreEntry?.tags || [],
    appCoreEntry?.subtype,
    kind,
    "built-in",
    "first-party",
    "elizaos",
  ]);

  return buildGeneratedEntry({
    packageName,
    repo,
    directory,
    version: pkg.version,
    coreRange: getCoreRange(pkg),
    description,
    homepage,
    topics,
    kind,
    appMeta,
    origin: "builtin",
    support: "first-party",
    branch: BUILTIN_BRANCH,
  });
}

function loadBuiltInEntries() {
  const appCoreEntries = loadAppCoreEntries();
  const entries = [];
  for (const pluginDir of packageDirs()) {
    const packagePath = path.join(PLUGINS_DIR, pluginDir, "package.json");
    const pkg = readJson(packagePath);
    const manifest = readOptionalPluginManifest(pluginDir);
    const appCoreEntry = appCoreEntries.get(pkg.name);
    entries.push([
      pkg.name,
      builtinEntryForPackage(pluginDir, pkg, manifest, appCoreEntry),
    ]);
  }
  return entries;
}

function thirdPartyMetadataFiles() {
  if (!fs.existsSync(THIRD_PARTY_DIR)) {
    fs.mkdirSync(THIRD_PARTY_DIR, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(THIRD_PARTY_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith("."),
    )
    .map((entry) => path.join(THIRD_PARTY_DIR, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeThirdPartyMeta(filePath) {
  const meta = readJson(filePath);
  const context = path.relative(REGISTRY_ROOT, filePath);
  const packageName = meta.package || meta.name;
  const repo = normalizeGithubRepo(meta.repository);
  const kind = meta.kind || "plugin";

  if (typeof packageName !== "string") {
    throw new Error(`${context}: "package" is required`);
  }
  assertPackageName(packageName, context);
  if (packageName.startsWith("@elizaos/")) {
    throw new Error(`${context}: @elizaos/* packages are reserved for built-ins`);
  }
  if (!repo) {
    throw new Error(`${context}: "repository" must be github:owner/repo`);
  }
  assertGitHubRepo(repo, context);
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`${context}: "kind" must be app, connector, or plugin`);
  }
  if (meta.directory !== undefined) {
    assertSafeDirectory(meta.directory, context);
  }
  if (
    meta.branch !== undefined &&
    (typeof meta.branch !== "string" || !SAFE_BRANCH_RE.test(meta.branch))
  ) {
    throw new Error(`${context}: "branch" must be a safe git branch name`);
  }
  if (meta.tags !== undefined && !Array.isArray(meta.tags)) {
    throw new Error(`${context}: "tags" must be an array of strings`);
  }
  if (
    meta.description !== undefined &&
    typeof meta.description !== "string"
  ) {
    throw new Error(`${context}: "description" must be a string`);
  }

  return {
    packageName,
    repo,
    directory: meta.directory || null,
    kind,
    version: npmLatestVersion(packageName) || meta.version || null,
    branch: meta.branch || "main",
    coreRange: meta.coreRange || null,
    description: meta.description || "",
    homepage: meta.homepage || null,
    topics: uniqueStrings([
      meta.tags || [],
      kind,
      "third-party",
      "community",
      "elizaos",
    ]),
    appMeta:
      kind === "app"
        ? {
            displayName: meta.app?.displayName || titleFromPackageName(packageName),
            category: meta.app?.category || "app",
            launchType: meta.app?.launchType || "url",
            launchUrl: meta.app?.launchUrl || null,
            icon: meta.app?.icon || null,
            heroImage: meta.app?.heroImage || null,
            capabilities: uniqueStrings(meta.app?.capabilities || []),
            minPlayers: meta.app?.minPlayers ?? null,
            maxPlayers: meta.app?.maxPlayers ?? null,
            runtimePlugin: meta.app?.runtimePlugin || packageName,
            bridgeExport: meta.app?.bridgeExport,
            uiExtension: meta.app?.uiExtension,
            viewer: meta.app?.viewer,
            session: meta.app?.session,
            developerOnly: meta.app?.developerOnly,
            visibleInAppStore: meta.app?.visibleInAppStore ?? true,
            mainTab: meta.app?.mainTab,
          }
        : null,
  };
}

function loadThirdPartyEntries() {
  return thirdPartyMetadataFiles().map((filePath) => {
    const meta = normalizeThirdPartyMeta(filePath);
    return [
      meta.packageName,
      buildGeneratedEntry({
        packageName: meta.packageName,
        repo: meta.repo,
        directory: meta.directory,
        version: meta.version,
        coreRange: meta.coreRange,
        description: meta.description,
        homepage: meta.homepage,
        topics: meta.topics,
        kind: meta.kind,
        appMeta: meta.appMeta,
        origin: "third-party",
        support: "community",
        branch: meta.branch,
      }),
    ];
  });
}

function buildRegistry() {
  const builtinEntries = loadBuiltInEntries();
  const thirdPartyEntries = loadThirdPartyEntries();
  const seen = new Set();

  for (const [packageName] of builtinEntries) {
    if (seen.has(packageName)) {
      throw new Error(`duplicate built-in package: ${packageName}`);
    }
    seen.add(packageName);
  }

  for (const [packageName] of thirdPartyEntries) {
    if (seen.has(packageName)) {
      throw new Error(
        `third-party package conflicts with built-in package: ${packageName}`,
      );
    }
    seen.add(packageName);
  }

  const registry = stableObject([...builtinEntries, ...thirdPartyEntries]);
  const index = stableObject(
    Object.entries(registry).map(([packageName, entry]) => [
      packageName,
      `github:${entry.git.repo}`,
    ]),
  );

  const counts = {
    total: Object.keys(registry).length,
    builtin: builtinEntries.length,
    thirdParty: thirdPartyEntries.length,
    app: Object.values(registry).filter((entry) => entry.kind === "app").length,
    connector: Object.values(registry).filter(
      (entry) => entry.kind === "connector",
    ).length,
    plugin: Object.values(registry).filter((entry) => entry.kind === "plugin")
      .length,
  };

  return { registry, index, counts };
}

function chooseTimestamp(registry, counts) {
  const existing = maybeReadJson(OUTPUT_FILES.generated);
  if (!existing || typeof existing.lastUpdatedAt !== "string") {
    return new Date().toISOString();
  }
  const existingComparable = JSON.stringify({
    schemaVersion: existing.schemaVersion,
    counts: existing.counts,
    registry: existing.registry,
  });
  const nextComparable = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    counts,
    registry,
  });
  return existingComparable === nextComparable
    ? existing.lastUpdatedAt
    : new Date().toISOString();
}

function buildOutputs() {
  const { registry, index, counts } = buildRegistry();
  const lastUpdatedAt = chooseTimestamp(registry, counts);
  const generated = {
    schemaVersion: SCHEMA_VERSION,
    lastUpdatedAt,
    generatedFrom: {
      builtinRepo: `github:${BUILTIN_REPO}`,
      builtinBranch: BUILTIN_BRANCH,
      builtinDirectory: "plugins",
      thirdPartyDirectory: "entries/third-party",
    },
    counts,
    registry,
  };
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    lastUpdatedAt,
    counts,
    packages: Object.entries(registry).map(([name, entry]) => ({
      name,
      kind: entry.kind,
      origin: entry.origin,
      support: entry.support,
      npmVersion: entry.npm.v2,
      repository: `github:${entry.git.repo}`,
      directory: entry.directory,
    })),
  };

  return { generated, index, summary };
}

function fileContents(filePath, data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function checkOutputs(outputs) {
  const failures = [];
  for (const [key, filePath] of Object.entries(OUTPUT_FILES)) {
    const expected = fileContents(filePath, outputs[key]);
    const actual = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : "";
    if (actual !== expected) {
      failures.push(path.relative(REGISTRY_ROOT, filePath));
    }
  }
  return failures;
}

function writeOutputs(outputs) {
  writeJson(OUTPUT_FILES.generated, outputs.generated);
  writeJson(OUTPUT_FILES.index, outputs.index);
  writeJson(OUTPUT_FILES.summary, outputs.summary);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const outputs = buildOutputs();
  const { counts } = outputs.generated;

  if (args.check) {
    const failures = checkOutputs(outputs);
    if (failures.length > 0) {
      console.error(
        `Registry outputs are stale. Regenerate: ${failures.join(", ")}`,
      );
      process.exit(1);
    }
    console.log(
      `Registry is current: ${counts.total} packages (${counts.builtin} built-in, ${counts.thirdParty} third-party).`,
    );
    return;
  }

  writeOutputs(outputs);
  console.log(
    `Generated ${counts.total} registry entries (${counts.builtin} built-in, ${counts.thirdParty} third-party).`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildOutputs,
  normalizeGithubRepo,
  normalizeThirdPartyMeta,
};
