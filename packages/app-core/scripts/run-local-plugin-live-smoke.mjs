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
const vitestConfigPath = path.join(
  repoRoot,
  "eliza/test/vitest/live-e2e.config.ts",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizePluginNpmName(name) {
  return name.endsWith("-root") ? name.slice(0, -5) : name;
}

function derivePluginId(name) {
  const normalized = normalizePluginNpmName(name);
  if (!normalized.startsWith("@elizaos/plugin-")) {
    return null;
  }

  return normalized.slice("@elizaos/plugin-".length);
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
    if (typeof plugin?.dirName !== "string" || plugin.dirName.length === 0) {
      continue;
    }
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

  const rootWrapperMatch = candidates.find((plugin) => {
    if (path.basename(plugin.packageRoot) !== "typescript") {
      return false;
    }
    return cwd === path.dirname(plugin.packageRoot);
  });
  if (rootWrapperMatch) {
    return rootWrapperMatch.id;
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
    const byName = candidates.find(
      (plugin) =>
        plugin.npmName === pkg.name || `${plugin.npmName}-root` === pkg.name,
    );
    if (byName) {
      return byName.id;
    }

    if (typeof pkg.name === "string") {
      return derivePluginId(pkg.name);
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

if (!pluginId) {
  // The plugin-lifecycle harness lifts ALL workspace plugins when no filter
  // is set, which deadlocks the child runtime under Cerebras-only env (no
  // embeddings, no Discord/Telegram tokens, etc.). When we can't derive a
  // plugin id from the cwd, skip with a yellow note instead of timing out.
  process.env.SKIP_REASON ||=
    "plugin-live-smoke: could not resolve plugin id from cwd " +
    `${cwd}; add the plugin to plugins.json or run from its package root`;
  console.log(`[plugin-live-smoke] [33m${process.env.SKIP_REASON}[0m`);
  process.exit(0);
}

const result = spawnSync(
  process.env.npm_execpath || process.env.BUN || "bun",
  [
    "x",
    "vitest",
    "run",
    "--config",
    "eliza/test/vitest/live-e2e.config.ts",
    "eliza/packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ELIZA_LIVE_TEST: "1",
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
