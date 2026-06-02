#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const filterArg = args.find(
  (arg) => arg === "--filter" || arg.startsWith("--filter="),
);
const filter =
  filterArg === "--filter"
    ? args[args.indexOf(filterArg) + 1]
    : filterArg?.slice("--filter=".length);
const hostViewExternals = [
  "react",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
  "lucide-react",
];

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

async function buildView(configPath) {
  const cwd = path.dirname(configPath);
  const label = path.relative(repoRoot, cwd);
  const config = await readViewConfig(configPath);
  const entry = path.resolve(cwd, config.entry);
  const outDir = path.resolve(cwd, config.outDir ?? "dist/views");
  const externals = uniqueStrings(
    [
      config.packageName,
      ...hostViewExternals,
      ...(await readPackageDependencyExternals(cwd)),
      ...(config.additionalExternals ?? []),
    ].filter(Boolean),
  );

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
    "import.meta.env.DEV=false",
    "--define",
    "import.meta.env.PROD=true",
    "--define",
    `import.meta.env.MODE=${JSON.stringify(process.env.NODE_ENV ?? "production")}`,
    "--define",
    "import.meta.env.SSR=false",
    "--define",
    `__ELIZA_VIEW_ID__=${JSON.stringify(config.viewId ?? "")}`,
    "--define",
    `__ELIZA_VIEW_EXPORT__=${JSON.stringify(config.componentExport ?? "default")}`,
  ];
  for (const external of externals) {
    buildArgs.push("--external", external);
  }

  const { status, output } = await runBun(buildArgs, cwd);
  if (status !== 0) {
    return { label, status: status ?? 1, output };
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
  return { label, status: 0, output };
}

function runBun(buildArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", buildArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, output: Buffer.concat(chunks) });
    });
  });
}

const concurrency = Math.min(
  configs.length,
  Math.max(1, os.cpus().length - 1),
);

const failures = [];
let nextIndex = 0;

async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= configs.length) return;
    const configPath = configs[index];
    const result = await buildView(configPath);
    console.log(`[build-views] ${result.label}`);
    if (result.output.length > 0) {
      process.stdout.write(result.output);
    }
    if (result.status !== 0) {
      failures.push(result);
    }
  }
}

await Promise.all(
  Array.from({ length: concurrency }, () => worker()),
);

if (failures.length > 0) {
  console.error(
    `[build-views] ${failures.length} view build(s) failed: ${failures
      .map((failure) => failure.label)
      .join(", ")}`,
  );
  const exitStatus = failures.find((failure) => failure.status > 0)?.status ?? 1;
  process.exit(exitStatus);
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

async function readPackageDependencyExternals(pluginDir) {
  const packageJsonPath = path.join(pluginDir, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ];
}

function uniqueStrings(values) {
  return [...new Set(values)];
}
