/** Opt-in photo-closure qualification (`bun run qualify:photo-closure`).
 * Produces its own production dry-run under test-results/, then runs the native
 * Worker/DO photo test against those exact bytes, the gateway photo tests and a
 * local `wrangler check startup`. Not part of typecheck or `bun run verify`.
 * Source commit/tree and dirty paths are reported, not enforced: this is not a
 * clean whole-source build attestation. Startup profiling is local only.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { testOutputPath } from "../../../../scripts/lib/test-output.ts";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(api, "../../..");
const output = testOutputPath("cloud-api-photo-qualification");
const buildDir = resolve(output, "worker");
const modulePath = resolve(buildDir, "index.js");
const bundlePath = resolve(buildDir, "worker.bundle");
const profilePath = resolve(output, "startup.cpuprofile");
const receiptPath = resolve(output, "receipt.json");
const nativeTest = "test/native-worker/network-photo-closure.native.test.ts";
const gatewayTests = [
  "approved-relay-photos.test.ts",
  "approved-photo-delivery.integration.test.ts",
  "internal-delivery-replay.test.ts",
  "blooio-adapter.test.ts",
].map((name) => `packages/cloud/services/gateway-webhook/__tests__/${name}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

async function artifact(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0)
    throw new Error(`Expected a nonempty regular artifact: ${path}`);
  const bytes = await readFile(path);
  return {
    bytes,
    proof: {
      sha256: hash(bytes),
      bytes: bytes.length,
      modifiedAt: info.mtime.toISOString(),
    },
  };
}

function sourceProvenance() {
  const dirtyPaths = git("diff", "--name-only", "HEAD")
    .split("\n")
    .filter(Boolean);
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: dirtyPaths.length !== 0,
    trackedDirtyPaths: dirtyPaths,
    limitation:
      "Reported for traceability only; working-tree changes are allowed and this is not a clean whole-source build attestation.",
  };
}

const receipt = {
  state: "QUALIFICATION_RUNNING",
  source: null,
  module: null,
  multipart: null,
  mainModule: null,
  scope: {
    builds: 1,
    sharedStorageCases: 5,
    gateway:
      "Real source paths with controlled HTTP/Redis transport; no real provider delivery.",
    startup:
      "Local module import/profile only; production namespace, database and service bindings are not qualified here.",
    limits:
      "No all-class operations, production namespace ownership, PG/provider access, item-policy approval or real-user photo acceptance.",
  },
  results: {},
};
const save = () =>
  writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

function run(stage, args, cwd, env = process.env) {
  const result = spawnSync("bun", args, { cwd, stdio: "inherit", env });
  receipt.results[stage] = { exitCode: result.status, signal: result.signal };
  if (result.error) receipt.results[stage].error = result.error.message;
  if (result.error || result.status !== 0)
    throw new Error(`${stage} qualification failed`);
}

const offlineWranglerEnv = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_API_KEY: "",
  CLOUDFLARE_EMAIL: "",
  WRANGLER_SEND_METRICS: "false",
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
try {
  receipt.source = sourceProvenance();
  await save();
  run(
    "build",
    [
      "x",
      "--no-install",
      "wrangler",
      "deploy",
      "--env",
      "production",
      "--dry-run",
      "--outdir",
      buildDir,
      "--outfile",
      bundlePath,
    ],
    api,
    offlineWranglerEnv,
  );
  // Normal src/index.ts produces index.js. No injected path or stale fallback.
  const entries = (await readdir(buildDir)).filter((name) =>
    /^index\.(?:js|mjs|cjs)$/.test(name),
  );
  if (entries.length !== 1 || entries[0] !== "index.js")
    throw new Error("Missing or ambiguous Wrangler index.js entry");
  const module = await artifact(modulePath);
  const bundle = await artifact(bundlePath);
  // check startup --worker consumes Wrangler's multipart upload bundle, not JS.
  // Verify that its actual main-module bytes are the same bytes tested below.
  const firstLine = bundle.bytes.indexOf(10);
  if (firstLine < 3 || firstLine > 200)
    throw new Error("Invalid multipart Worker boundary");
  const boundary = bundle.bytes.subarray(2, firstLine).toString().trim();
  const parts = await new Response(bundle.bytes, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const metadata = parts.get("metadata");
  if (typeof metadata !== "string")
    throw new Error("Missing Worker upload metadata");
  const mainName = JSON.parse(metadata).main_module;
  if (typeof mainName !== "string")
    throw new Error("Missing Worker main-module identity");
  const mainPart = parts.get(mainName);
  if (
    !(mainPart instanceof Blob) ||
    hash(new Uint8Array(await mainPart.arrayBuffer())) !== module.proof.sha256
  )
    throw new Error("Multipart main module differs from the index.js artifact");
  receipt.module = module.proof;
  receipt.multipart = bundle.proof;
  receipt.mainModule = mainName;
  await save();

  run(
    "native",
    [
      "test",
      "--config=/dev/null",
      "--isolate",
      nativeTest,
      "--timeout",
      "60000",
    ],
    api,
    {
      ...process.env,
      ELIZA_QA_WORKER_MODULE: modulePath,
      ELIZA_QA_WORKER_SHA256: module.proof.sha256,
    },
  );
  run(
    "gateway",
    [
      "test",
      "--config=/dev/null",
      "--isolate",
      ...gatewayTests,
      "--timeout",
      "60000",
    ],
    repo,
  );
  run(
    "startup",
    [
      "x",
      "--no-install",
      "wrangler",
      "check",
      "startup",
      "--worker",
      bundlePath,
      "--outfile",
      profilePath,
      "--config",
      "wrangler.toml",
      "--env",
      "production",
    ],
    api,
    offlineWranglerEnv,
  );
  receipt.startupProfile = (await artifact(profilePath)).proof;
  if (
    (await artifact(modulePath)).proof.sha256 !== module.proof.sha256 ||
    (await artifact(bundlePath)).proof.sha256 !== bundle.proof.sha256
  )
    throw new Error("Qualified Worker artifacts changed during qualification");
  receipt.state = "QUALIFICATION_PASSED";
} catch (error) {
  receipt.state = "QUALIFICATION_FAILED";
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await save();
  // Never print bindings, environment values, tokens, message bodies or the
  // multipart metadata.
  console.log(
    JSON.stringify({
      kind: "network-photo-qualification",
      state: receipt.state,
      receiptPath,
      sourceCommit: receipt.source?.commit ?? null,
      sourceTree: receipt.source?.tree ?? null,
      dirty: receipt.source?.dirty ?? null,
      trackedDirtyPaths: receipt.source?.trackedDirtyPaths ?? [],
      moduleSHA256: receipt.module?.sha256 ?? null,
      multipartSHA256: receipt.multipart?.sha256 ?? null,
      startupProfileSHA256: receipt.startupProfile?.sha256 ?? null,
      results: receipt.results,
      error: receipt.error ?? null,
    }),
  );
}
