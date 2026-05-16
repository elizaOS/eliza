#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const filterArg = args.find((arg) => arg === "--filter" || arg.startsWith("--filter="));
const filter =
  filterArg === "--filter"
    ? args[args.indexOf(filterArg) + 1]
    : filterArg?.slice("--filter=".length);

async function findViewConfigs() {
  const pluginsDir = path.join(repoRoot, "plugins");
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsDir, entry.name, "vite.config.views.ts"))
    .filter((configPath) => existsSync(configPath))
    .filter((configPath) => {
      if (!filter) return true;
      const pluginName = path.basename(path.dirname(configPath));
      return pluginName.includes(filter) || `@elizaos/${pluginName}` === filter;
    })
    .sort();
}

const configs = await findViewConfigs();
if (configs.length === 0) {
  console.log("[build-views] no view configs found");
  process.exit(0);
}

for (const configPath of configs) {
  const cwd = path.dirname(configPath);
  const label = path.relative(repoRoot, cwd);
  console.log(`[build-views] ${label}`);
  const config = await readViewConfig(configPath);
  const entry = path.resolve(cwd, config.entry);
  const outDir = path.resolve(cwd, config.outDir ?? "dist/views");
  const externals = [
    config.packageName,
    ...(config.additionalExternals ?? []),
  ].filter(Boolean);

  await mkdir(outDir, { recursive: true });
  const buildArgs = [
    "build",
    entry,
    "--outdir",
    outDir,
    "--target",
    "browser",
    "--format",
    "esm",
    "--sourcemap=external",
    "--naming=bundle.js",
    "--define",
    `process.env.NODE_ENV=${JSON.stringify(process.env.NODE_ENV ?? "production")}`,
    "--define",
    `__ELIZA_VIEW_ID__=${JSON.stringify(config.viewId ?? "")}`,
    "--define",
    `__ELIZA_VIEW_EXPORT__=${JSON.stringify(config.componentExport ?? "default")}`,
  ];
  for (const external of externals) {
    buildArgs.push("--external", external);
  }
  const result = spawnSync("bun", buildArgs, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const emittedName = `${path.basename(entry, path.extname(entry))}.js`;
  const emittedPath = path.join(outDir, emittedName);
  const bundlePath = path.join(outDir, "bundle.js");
  if (emittedPath !== bundlePath && existsSync(emittedPath)) {
    await rename(emittedPath, bundlePath);
  }
  const emittedMapPath = `${emittedPath}.map`;
  const bundleMapPath = `${bundlePath}.map`;
  if (emittedMapPath !== bundleMapPath && existsSync(emittedMapPath)) {
    await rename(emittedMapPath, bundleMapPath);
  }
}

async function readViewConfig(configPath) {
  const source = await readFile(configPath, "utf8");
  return {
    packageName: readStringProperty(source, "packageName"),
    viewId: readStringProperty(source, "viewId"),
    entry: readStringProperty(source, "entry"),
    outDir: readStringProperty(source, "outDir"),
    componentExport: readStringProperty(source, "componentExport"),
    additionalExternals: readStringArrayProperty(source, "additionalExternals"),
  };
}

function readStringProperty(source, name) {
  const match = source.match(
    new RegExp(`${name}\\s*:\\s*["']([^"']+)["']`, "m"),
  );
  return match?.[1];
}

function readStringArrayProperty(source, name) {
  const match = source.match(
    new RegExp(`${name}\\s*:\\s*\\[([\\s\\S]*?)\\]`, "m"),
  );
  if (!match) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}
