/**
 * Exact-head module-graph proof for #18056 idle /login private-chunk budget.
 *
 * Builds code-split ESM graphs (`splitting: true`) so dynamic `import()` of
 * private dashboard domains land in **async chunks**, not the entry chunk.
 * Idle `/login` only loads `register-public` (entry) — private markers must
 * not appear in the entry chunk's input set.
 *
 * Control: `register-all` entry chunk must include private domains statically.
 *
 * Run: bun packages/ui/src/cloud/__e2e__/prove-public-boot-chunk-budget.mjs
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const uiCloud = resolve(here, "..");
const outDir = join(here, "output-chunk-budget");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const PRIVATE_MARKERS = [
  "/cloud/instances",
  "/cloud/analytics",
  "/cloud/home/routes",
  "/cloud/billing/routes",
  "/cloud/api-keys/routes",
  "/cloud/account-security/routes",
  "/cloud/monetization/routes",
  "/cloud/connectors/routes",
  "/cloud/organization/routes",
  "/cloud/admin",
  "/cloud/api-explorer",
  "/cloud/approvals",
  "/cloud/mcps",
  "/cloud/settings",
];

function normalize(p) {
  return p.replaceAll("\\", "/").toLowerCase();
}

function findPrivateHits(paths) {
  const norm = paths.map(normalize);
  return PRIVATE_MARKERS.filter((marker) =>
    norm.some((p) => p.includes(marker.toLowerCase())),
  );
}

/**
 * Collect files that contribute to the entry chunk only (not async chunks).
 * esbuild metafile: each output has `inputs` and `entryPoint` / `imports`.
 */
function entryChunkInputs(metafile, entryPath) {
  const entryNorm = normalize(entryPath);
  const outputs = Object.entries(metafile.outputs);
  // Prefer the output that lists this file as entryPoint.
  let entryOut = outputs.find(([, out]) =>
    out.entryPoint ? normalize(out.entryPoint).endsWith(
      entryNorm.split("/").slice(-2).join("/"),
    ) || normalize(out.entryPoint).includes("register-public") ||
      normalize(out.entryPoint).includes("register-all")
      : false,
  );
  if (!entryOut) {
    // Fallback: largest output with entryPoint set
    entryOut = outputs
      .filter(([, out]) => out.entryPoint)
      .sort((a, b) => (b[1].bytes ?? 0) - (a[1].bytes ?? 0))[0];
  }
  if (!entryOut) {
    throw new Error("no entry output in metafile");
  }
  const [outPath, out] = entryOut;
  return {
    outPath,
    entryPoint: out.entryPoint,
    inputPaths: Object.keys(out.inputs ?? {}),
    // Dynamic imports from this chunk (async boundaries)
    dynamicImports: (out.imports ?? [])
      .filter((i) => i.kind === "dynamic-import")
      .map((i) => i.path),
    staticImports: (out.imports ?? [])
      .filter((i) => i.kind === "import-statement")
      .map((i) => i.path),
  };
}

async function analyze(entry, label) {
  const buildOut = join(outDir, label);
  await mkdir(buildOut, { recursive: true });
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    outdir: buildOut,
    metafile: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    packages: "external",
    loader: {
      ".tsx": "tsx",
      ".ts": "ts",
      ".css": "empty",
      ".svg": "empty",
      ".png": "empty",
      ".jpg": "empty",
      ".woff": "empty",
      ".woff2": "empty",
    },
    logLevel: "silent",
  });

  const entryInfo = entryChunkInputs(result.metafile, entry);
  const privateInEntry = findPrivateHits(entryInfo.inputPaths);
  // All inputs across all chunks (for control comparison)
  const allInputs = Object.keys(result.metafile.inputs);
  const privateAnywhere = findPrivateHits(allInputs);

  const report = {
    label,
    entry,
    entryPoint: entryInfo.entryPoint,
    entryOutPath: entryInfo.outPath,
    entryInputCount: entryInfo.inputPaths.length,
    privateInEntryChunk: privateInEntry,
    privateAnywhereInGraph: privateAnywhere,
    dynamicImportCount: entryInfo.dynamicImports.length,
    entryCloudInputs: entryInfo.inputPaths
      .map(normalize)
      .filter((p) => p.includes("/cloud/"))
      .slice(0, 60),
  };

  await writeFile(
    join(outDir, `${label}-report.json`),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    join(outDir, `${label}-metafile.json`),
    JSON.stringify(result.metafile, null, 2),
  );
  return report;
}

console.log("== progressive public boot (register-public entry chunk) ==");
const publicReport = await analyze(
  join(uiCloud, "register-public.ts"),
  "register-public",
);
console.log(JSON.stringify({
  entryInputs: publicReport.entryInputCount,
  privateInEntry: publicReport.privateInEntryChunk,
  privateAnywhere: publicReport.privateAnywhereInGraph.length,
  dynamicImports: publicReport.dynamicImportCount,
}, null, 2));

if (publicReport.privateInEntryChunk.length > 0) {
  console.error("FAIL: private modules in register-public ENTRY chunk:");
  for (const h of publicReport.privateInEntryChunk) console.error("  -", h);
  process.exit(1);
}
console.log(
  "✓ register-public entry chunk has zero private dashboard modules",
);
console.log(
  `  (private modules only reachable via ${publicReport.dynamicImportCount} dynamic import(s) / async chunks)`,
);

console.log("== full sync register-all (control entry chunk) ==");
const allReport = await analyze(join(uiCloud, "register-all.ts"), "register-all");
console.log(JSON.stringify({
  entryInputs: allReport.entryInputCount,
  privateInEntry: allReport.privateInEntryChunk.length,
}, null, 2));

if (allReport.privateInEntryChunk.length === 0) {
  console.error(
    "FAIL: register-all control entry unexpectedly has zero private modules",
  );
  process.exit(1);
}
console.log(
  `✓ register-all control entry includes private modules (${allReport.privateInEntryChunk.length} markers)`,
);

const budget = {
  headNote:
    "Idle /login loads register-public entry only; private static entry budget = 0. Private domains load only via ensurePrivateCloudSurfaces dynamic import().",
  publicBootEntryPrivateModuleCount: publicReport.privateInEntryChunk.length,
  fullRegisterEntryPrivateModuleCount: allReport.privateInEntryChunk.length,
  maxAllowedPublicBootEntryPrivateModules: 0,
  publicBootDynamicImportCount: publicReport.dynamicImportCount,
  ok: publicReport.privateInEntryChunk.length === 0,
};
await writeFile(join(outDir, "chunk-budget.json"), JSON.stringify(budget, null, 2));
console.log("chunk budget:", JSON.stringify(budget, null, 2));
console.log(`artifacts → ${outDir}`);
console.log("public boot chunk budget PASSED");
