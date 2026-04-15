import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Script lives at eliza/packages/app-core/scripts/ — repo root is 4 levels up.
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const cwd = path.resolve(process.cwd());
const pluginsManifestPath = path.join(repoRoot, "plugins.json");
const liveTestPath = path.join(
  repoRoot,
  "eliza",
  "packages",
  "app-core",
  "test",
  "live-agent",
  "plugin-lifecycle.live.e2e.test.ts",
);
const vitestConfigPath = path.join(repoRoot, "test/vitest/live-e2e.config.ts");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolvePackageRoot(dirName) {
  const candidates = [
    path.join(repoRoot, "eliza", "plugins", dirName, "typescript"),
    path.join(repoRoot, "eliza", "plugins", dirName),
    path.join(repoRoot, "eliza", "packages", dirName),
    path.join(repoRoot, "plugins", dirName, "typescript"),
    path.join(repoRoot, "plugins", dirName),
    path.join(repoRoot, "packages", dirName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return path.resolve(candidate);
    }
  }

  return null;
}

function resolvePluginCandidates() {
  if (!fs.existsSync(pluginsManifestPath)) {
    return [];
  }

  const manifest = readJson(pluginsManifestPath);
  const candidates = [];

  for (const plugin of manifest.plugins ?? []) {
    const packageRoot = resolvePackageRoot(plugin.dirName);
    if (!packageRoot) {
      continue;
    }
    candidates.push({
      id: plugin.id,
      npmName: plugin.npmName,
      dirName: plugin.dirName,
      packageRoot,
    });
  }

  return candidates;
}

function resolvePluginFilter(candidates) {
  const match = candidates.find((plugin) => cwd === plugin.packageRoot);
  if (match) {
    return match.id;
  }

  const fallbackMatch = candidates.find((plugin) =>
    cwd.startsWith(`${plugin.packageRoot}${path.sep}`),
  );
  if (fallbackMatch) {
    return fallbackMatch.id;
  }

  const packageJsonPath = path.join(cwd, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const pkg = readJson(packageJsonPath);
    const byName = candidates.find((plugin) => plugin.npmName === pkg.name);
    if (byName) {
      return byName.id;
    }
  }

  return null;
}

const pluginCandidates = resolvePluginCandidates();
const pluginId = resolvePluginFilter(pluginCandidates);

if (pluginCandidates.length === 0) {
  console.log(
    "[plugin-live-smoke] Skipping plugin runtime smoke because no local first-party plugin packages are available in this checkout.",
  );
  process.exit(0);
}

if (!fs.existsSync(liveTestPath) || !fs.existsSync(vitestConfigPath)) {
  console.log(
    "[plugin-live-smoke] Skipping plugin runtime smoke because the shared live test harness is not available in this checkout.",
  );
  process.exit(0);
}

const result = spawnSync(
  process.env.npm_execpath || process.env.BUN || "bun",
  [
    "x",
    "vitest",
    "run",
    "--config",
    "test/vitest/live-e2e.config.ts",
    "eliza/packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ELIZA_LIVE_TEST: "1",
      MILADY_LIVE_TEST: "1",
      ...(pluginId ? { ELIZA_PLUGIN_LIFECYCLE_FILTER: pluginId } : {}),
    },
  },
);

if (result.error?.code === "ENOENT") {
  console.log(
    `[plugin-live-smoke] Skipping plugin runtime smoke because the test runner could not be launched: ${result.error.message}`,
  );
  process.exit(0);
}

process.exit(result.status ?? 1);
