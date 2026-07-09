/**
 * App dist profiler for pendant lazy-bundle safety.
 *
 * It inspects a built app directory and verifies `opus-decoder` and native BLE
 * code are absent from initial scripts while reporting initial and lazy bytes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { hostInfo, writeJsonReport } from "./collector";

interface CliOptions {
  dist: string;
  baselineDist?: string;
  build: boolean;
  out?: string;
}

const options = parseArgs(process.argv.slice(2));
if (options.build) {
  const result = spawnSync(
    "bun",
    ["run", "--cwd", "../../packages/app", "build"],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    const report = failureReport(
      options.dist,
      `app build failed with exit code ${result.status ?? "unknown"}`,
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    );
    writeJsonReport(options.out, report);
    process.exitCode = 1;
    process.exit();
  }
}
const report = existsSync(options.dist)
  ? profile(options.dist, options.baselineDist)
  : failureReport(options.dist, `dist directory not found: ${options.dist}`);
writeJsonReport(options.out, report);
if (!report.pass) process.exitCode = 1;

function profile(dist: string, baselineDist: string | undefined) {
  const current = profileOneDist(dist);
  const baseline =
    baselineDist && existsSync(baselineDist)
      ? profileOneDist(baselineDist)
      : undefined;
  const deltaInitialBytes = baseline
    ? current.initialBytes - baseline.initialBytes
    : null;
  const deltaBudgetBytes = 25 * 1024;
  const checks = {
    opusDecoderLazy: current.opusInitialBytes === 0,
    nativeBleLazy: current.nativeBleInitialBytes === 0,
    initialDeltaWithinBudget:
      deltaInitialBytes === null || deltaInitialBytes <= deltaBudgetBytes,
  };
  return {
    issue: 15744,
    lane: "pendant-bundle-startup",
    host: hostInfo(),
    dist,
    baselineDist,
    budgets: {
      initialDeltaBytesMax: deltaBudgetBytes,
      opusInitialBytesMax: 0,
      nativeBleInitialBytesMax: 0,
    },
    current,
    baseline,
    delta: {
      initialBytes: deltaInitialBytes,
    },
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

function profileOneDist(dist: string) {
  const indexPath = join(dist, "index.html");
  const indexHtml = readFileSync(indexPath, "utf8");
  const entryScripts = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(Boolean)
    .map((path) => normalizeAssetPath(path));
  const modulePreloads = [
    ...indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
    ...indexHtml.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="modulepreload"/g),
  ]
    .map((match) => match[1])
    .filter(Boolean)
    .map((path) => normalizeAssetPath(path));
  const assets = listFiles(dist).filter((file) => /\.(js|css)$/.test(file));
  const assetByRel = new Map(
    assets.map((file) => [relative(dist, file), file]),
  );
  const initialSet = computeInitialClosure(
    [...entryScripts, ...modulePreloads],
    assetByRel,
  );
  const records = assets.map((file) => {
    const rel = relative(dist, file);
    const text = readFileSync(file, "utf8");
    return {
      file: rel,
      bytes: statSync(file).size,
      initial: initialSet.has(rel),
      isOpusLazyChunk:
        /(?:^|\/)opus-decoder-[^/]+\.js$/.test(rel) ||
        text.includes("opus_decoder_create") ||
        text.includes("opus_decode_float"),
      isNativeBleLazyChunk:
        /(?:^|\/)native-ble-transport-[^/]+\.js$/.test(rel) ||
        (text.includes("BluetoothLe") && text.includes("requestDevice")) ||
        (text.includes("androidNeverForLocation") &&
          text.includes("pendant not connected")),
      isPendantAudioChunk:
        text.includes("OMI_AUDIO_SERVICE_UUID") ||
        text.includes("createPendantAudioDecoder") ||
        text.includes("PENDANT_LATENCY_CONTRACT_VERSION"),
    };
  });
  const initialBytes = sum(records.filter((record) => record.initial));
  const pendantLazyBytes = sum(
    records.filter((record) => !record.initial && record.isPendantAudioChunk),
  );
  const opusInitialBytes = sum(
    records.filter((record) => record.initial && record.isOpusLazyChunk),
  );
  const nativeBleInitialBytes = sum(
    records.filter((record) => record.initial && record.isNativeBleLazyChunk),
  );
  return {
    dist,
    initialBytes,
    pendantLazyBytes,
    opusInitialBytes,
    nativeBleInitialBytes,
    entryScripts,
    modulePreloads,
    initialFiles: [...initialSet].sort(),
    opusLazyChunks: records.filter((record) => record.isOpusLazyChunk),
    nativeBleLazyChunks: records.filter(
      (record) => record.isNativeBleLazyChunk,
    ),
    pendantAudioChunks: records.filter((record) => record.isPendantAudioChunk),
  };
}

function failureReport(dist: string, reason: string, buildOutput?: string) {
  return {
    issue: 15744,
    lane: "pendant-bundle-startup",
    host: hostInfo(),
    dist,
    pass: false,
    reason,
    buildOutputTail: buildOutput?.slice(-8_000),
    knownBlocker:
      buildOutput?.includes("@elizaos/cloud-routing") ||
      buildOutput?.includes("cloud-routing")
        ? "packages/app build is blocked by the existing @elizaos/cloud-routing declaration failure"
        : undefined,
  };
}

function computeInitialClosure(
  roots: readonly string[],
  assetByRel: ReadonlyMap<string, string>,
): Set<string> {
  const initial = new Set<string>();
  const queue = roots.filter((root) => assetByRel.has(root));
  while (queue.length > 0) {
    const rel = queue.shift();
    if (!rel || initial.has(rel)) continue;
    initial.add(rel);
    if (!rel.endsWith(".js")) continue;
    const text = readFileSync(assetByRel.get(rel) ?? "", "utf8");
    for (const imported of staticImports(text)) {
      const normalized = normalizeAssetPath(imported, rel);
      if (assetByRel.has(normalized) && !initial.has(normalized)) {
        queue.push(normalized);
      }
    }
  }
  return initial;
}

function staticImports(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(
    /(?:import|export)\s+(?:[^('"`]*?\s+from\s*)?["']([^"']+)["']/g,
  )) {
    if (match[1]?.startsWith(".")) out.push(match[1]);
  }
  return out;
}

function normalizeAssetPath(path: string, importer?: string): string {
  const withoutQuery = path.split("?")[0]?.replace(/^\//, "") ?? path;
  if (!withoutQuery.startsWith(".")) return withoutQuery;
  const base = importer?.includes("/")
    ? importer.slice(0, importer.lastIndexOf("/") + 1)
    : "";
  const parts = `${base}${withoutQuery}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

function sum(records: readonly { bytes: number }[]): number {
  return records.reduce((total, record) => total + record.bytes, 0);
}

function parseArgs(args: readonly string[]): CliOptions {
  let dist = "../../packages/app/dist";
  let baselineDist: string | undefined;
  let build = false;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dist") dist = args[index + 1] ?? dist;
    if (arg === "--baseline-dist") baselineDist = args[index + 1];
    if (arg === "--build") build = true;
    if (arg === "--out") out = args[index + 1];
  }
  return { dist, baselineDist, build, out };
}
