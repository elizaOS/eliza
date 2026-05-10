#!/usr/bin/env node
// eliza/packages/app-core/scripts/aosp/stage-default-models.mjs —
// fetch and stage the default chat + embedding GGUF models into the
// privileged AOSP system app's android assets so a fresh install
// boots straight into a working chat without needing network access.
//
// Why bundle, not download-on-first-run:
//   The intended UX is "boot the AOSP image → chat works". Download-
//   on-first-run requires (a) network at first boot, (b) a UI prompt
//   the user must satisfy, (c) an extra ~400 MB transfer that will be
//   re-downloaded for every fresh image. Bundling pays the size cost
//   once at APK build time, then every install is offline-capable.
//
// Output (per ABI is unnecessary — GGUF files are arch-independent):
//   apps/app/android/app/src/main/assets/agent/models/<file>.gguf
//   apps/app/android/app/src/main/assets/agent/models/manifest.json
//
// On-device: ElizaAgentService (or any white-label fork's equivalent)
// extracts assets/agent/models/* into the per-user state dir's
// `local-inference/models/`, then the runtime's first-run bootstrap
// scans the directory and registers each file in the local-inference
// registry tagged with the manifest's `source` field, which the
// staging step writes from `app.config.ts > aosp.modelSourceLabel`
// (e.g. `"acme-download"` for a fork named "AcmeOS").
//
// APK size impact (Q4_K_M quants):
//   Llama-3.2-1B-Instruct          ~770 MB
//   bge-small-en-v1.5              ~28 MB
//   --------------------------------------
//   total                          ~800 MB
//
// Why Llama-3.2-1B over SmolLM2-360M (the previous default):
//   - 128k native context window vs SmolLM2's 8k. The planner builds
//     ~12k-token prompts on every chat turn (system + tools + history +
//     user message). With 8k ctx we head-truncated 8k+ tokens per turn,
//     dropping the planner's tool descriptions and producing malformed
//     output. With 128k ctx the entire prompt fits, the planner gets
//     coherent tool grammar, and the model produces parseable actions.
//   - 1B parameters vs 360M. 1B is the smallest model that reliably
//     follows the planner's output schema without producing Python
//     test code, repeated fragments, or unrelated text. The size cost
//     (~500 MB more APK) is paid once at build time; on-device inference
//     speed difference is small on CPU (both are bottlenecked on memory
//     bandwidth, not compute).
//   - Same Q4_K_M quant, same Bartowski repo conventions, same FFI
//     loader path. No code changes elsewhere.
//
// Opt out for builders who want to download at runtime instead:
//   --skip-bundled-models       (passed by build-aosp.mjs)
//   ELIZA_SKIP_BUNDLED_MODELS=1 (env var, also respected)
//
// Idempotent: re-running with the same files on disk and matching size
// is a no-op. A size mismatch triggers a re-download. The script never
// deletes other files in the assets/agent/models/ dir.

import { createHash } from "node:crypto";
import fsSync, { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

/**
 * Models to bundle. IDs match `MODEL_CATALOG` entries in
 * eliza/packages/app-core/src/services/local-inference/catalog.ts so the
 * runtime registry treats them as known catalog models, not orphans.
 *
 * The embedding model has no catalog entry yet (catalog only carries
 * chat models); we still register it under the fork's brand source
 * label with a stable id so the auto-assign logic can wire it to
 * TEXT_EMBEDDING.
 *
 * Sizes are sanity-checked at download time. If HuggingFace serves
 * a smaller file (e.g. partial download, repo deleted, replaced) the
 * staging step fails loudly rather than shipping a broken APK.
 */
// Bundle profile selector. The default ("full") bundles Llama-3.2-1B
// — Shaw's architectural pick (see comment at top of this file: 128k
// ctx, smallest model that reliably follows planner output schema).
// `MILADYOS_BUNDLE_PROFILE=vm` opts INTO SmolLM2-360M as a smaller
// model for low-RAM emulators. Empirically tested on Cuttlefish
// (2026-05-10): SmolLM2 ran at ~0.14 tok/s vs Llama-3.2-1B at
// ~0.9 tok/s on the same x86_64 CPU. SmolLM2 has more transformer
// layers (per-token cost is sequential across layers), so its smaller
// param count does NOT translate to speed at this context size. The
// vm profile is preserved for future use cases (extreme low-RAM
// devices, models that benefit from the smaller weights), not for
// dev-loop speed.
const VM_DEV_PROFILE = process.env.MILADYOS_BUNDLE_PROFILE === "vm";

const CHAT_MODEL_LLAMA_3_2_1B = {
  id: "llama-3.2-1b",
  displayName: "Llama 3.2 1B Instruct",
  hfRepo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
  ggufFile: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
  // Q4_K_M quant of Llama-3.2-1B is ~808 MB on HuggingFace
  // (807,694,464 bytes observed on 2026-04-29). Bracket loosely so
  // a future re-quant of slightly different size still passes.
  expectedMinBytes: 700 * 1024 * 1024, // 700 MB lower bound
  expectedMaxBytes: 900 * 1024 * 1024, // 900 MB upper bound
  role: "chat",
};

const CHAT_MODEL_SMOLLM2_360M = {
  id: "smollm2-360m",
  displayName: "SmolLM2 360M Instruct",
  hfRepo: "bartowski/SmolLM2-360M-Instruct-GGUF",
  ggufFile: "SmolLM2-360M-Instruct-Q4_K_M.gguf",
  // Q4_K_M of SmolLM2-360M is ~270 MB on HuggingFace.
  expectedMinBytes: 200 * 1024 * 1024, // 200 MB lower bound
  expectedMaxBytes: 350 * 1024 * 1024, // 350 MB upper bound
  role: "chat",
};

export const DEFAULT_MODELS = [
  VM_DEV_PROFILE ? CHAT_MODEL_SMOLLM2_360M : CHAT_MODEL_LLAMA_3_2_1B,
  {
    id: "bge-small-en-v1.5",
    displayName: "BGE Small EN v1.5 (embedding)",
    hfRepo: "ChristianAzinn/bge-small-en-v1.5-gguf",
    ggufFile: "bge-small-en-v1.5.Q4_K_M.gguf",
    // The Q4_K_M quant of BGE small en v1.5 is ~28 MB (29,203,744 bytes
    // observed on HuggingFace). The lower bound was previously 30 MB, which
    // rejected the legitimate file. Loosen to 25 MB so transient HF
    // re-quants of slightly different sizes still pass the sanity check.
    expectedMinBytes: 25 * 1024 * 1024, // 25 MB lower bound
    expectedMaxBytes: 200 * 1024 * 1024, // 200 MB upper bound
    role: "embedding",
  },
];

const ASSETS_MODELS_DIR = path.join(
  repoRoot,
  "apps",
  "app",
  "android",
  "app",
  "src",
  "main",
  "assets",
  "agent",
  "models",
);

const MANIFEST_PATH = path.join(ASSETS_MODELS_DIR, "manifest.json");

function hfResolveUrl(repo, file) {
  // The /resolve/main/ path serves the LFS-hydrated file, not the
  // pointer. /raw/ would serve the LFS pointer text and break us.
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

async function fileSize(p) {
  try {
    const stat = await fs.stat(p);
    return stat.size;
  } catch (error) {
    if (error.code === "ENOENT") return -1;
    throw error;
  }
}

async function streamDownload(url, dest, sizeMin, sizeMax) {
  // Use Node's built-in fetch (Node 22 has it); follow redirects, fail
  // fast on non-200, content-length mismatch, or under-size.
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "ElizaOS-AOSP-build/1.0" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  if (contentLength && (contentLength < sizeMin || contentLength > sizeMax)) {
    throw new Error(
      `Content-Length ${contentLength} for ${url} is outside expected range ${sizeMin}-${sizeMax}`,
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const sink = createWriteStream(tmp);
  const hash = createHash("sha256");
  let written = 0;
  // The body is a web ReadableStream in Node 22; iterate via reader.
  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      written += value.length;
      sink.write(value);
    }
    sink.end();
    // Wait for the FS write to flush.
    await new Promise((resolve, reject) => {
      sink.on("finish", resolve);
      sink.on("error", reject);
    });
    if (written < sizeMin) {
      throw new Error(
        `Downloaded ${written} bytes but expected at least ${sizeMin} for ${url}`,
      );
    }
    if (written > sizeMax) {
      throw new Error(
        `Downloaded ${written} bytes but expected at most ${sizeMax} for ${url}`,
      );
    }
    await fs.rename(tmp, dest);
    return { sizeBytes: written, sha256: hash.digest("hex") };
  } catch (error) {
    sink.destroy();
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function readExistingManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseStagingArgs(argv) {
  const out = { skip: false, sourceLabel: null, appConfigPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-bundled-models") {
      out.skip = true;
    } else if (arg === "--source-label") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--source-label requires a value");
      }
      out.sourceLabel = value;
      i += 1;
    } else if (arg === "--app-config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--app-config requires a value");
      }
      out.appConfigPath = path.resolve(value);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/stage-default-models.mjs " +
          "[--source-label <STR>] [--app-config <PATH>] [--skip-bundled-models]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out.skip && process.env.ELIZA_SKIP_BUNDLED_MODELS === "1") {
    out.skip = true;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const {
    skip,
    sourceLabel: sourceLabelArg,
    appConfigPath: appConfigArg,
  } = parseStagingArgs(argv);
  if (skip) {
    console.log(
      "[stage-default-models] --skip-bundled-models / ELIZA_SKIP_BUNDLED_MODELS=1; nothing to do.",
    );
    return;
  }

  // Source label drives the manifest's `source` field, which the
  // runtime first-run bootstrap reads to tag each registered model
  // (e.g. `"acme-download"` for an "AcmeOS" fork). CLI flag wins,
  // then app.config.ts > aosp.modelSourceLabel, then a generic
  // `"eliza-bundled"` fallback so the manifest field is always
  // populated.
  let sourceLabel = sourceLabelArg;
  if (!sourceLabel) {
    const appConfigPath = resolveAppConfigPath({
      repoRoot,
      flagValue: appConfigArg,
    });
    if (fsSync.existsSync(appConfigPath)) {
      const variant = loadAospVariantConfig({ appConfigPath });
      if (variant?.modelSourceLabel) {
        sourceLabel = variant.modelSourceLabel;
      }
    }
  }
  if (!sourceLabel) sourceLabel = "eliza-bundled";

  await fs.mkdir(ASSETS_MODELS_DIR, { recursive: true });

  const existingManifest = await readExistingManifest();
  const manifestEntries = [];

  for (const model of DEFAULT_MODELS) {
    const dest = path.join(ASSETS_MODELS_DIR, model.ggufFile);
    const have = await fileSize(dest);
    if (have >= model.expectedMinBytes && have <= model.expectedMaxBytes) {
      console.log(
        `[stage-default-models] ${model.id}: already staged (${have} bytes), skipping.`,
      );
      // Try to reuse the existing manifest entry rather than re-hashing.
      const prior = existingManifest?.models?.find((m) => m.id === model.id);
      manifestEntries.push({
        id: model.id,
        displayName: model.displayName,
        hfRepo: model.hfRepo,
        ggufFile: model.ggufFile,
        role: model.role,
        sizeBytes: have,
        sha256: prior?.sha256 ?? null,
      });
      continue;
    }
    if (have >= 0) {
      console.log(
        `[stage-default-models] ${model.id}: stale (${have} bytes), re-downloading.`,
      );
    } else {
      console.log(
        `[stage-default-models] ${model.id}: downloading from ${model.hfRepo}...`,
      );
    }
    const url = hfResolveUrl(model.hfRepo, model.ggufFile);
    const { sizeBytes, sha256 } = await streamDownload(
      url,
      dest,
      model.expectedMinBytes,
      model.expectedMaxBytes,
    );
    console.log(
      `[stage-default-models] ${model.id}: downloaded ${sizeBytes} bytes (sha256=${sha256.slice(0, 12)}...)`,
    );
    manifestEntries.push({
      id: model.id,
      displayName: model.displayName,
      hfRepo: model.hfRepo,
      ggufFile: model.ggufFile,
      role: model.role,
      sizeBytes,
      sha256,
    });
  }

  // Manifest is read by the runtime's first-run bootstrap to register
  // these models in the local-inference registry. Format is
  // intentionally self-describing — `version: 1`, a `source` label
  // per-fork, then a flat array of model objects.
  const manifest = {
    version: 1,
    source: sourceLabel,
    models: manifestEntries,
  };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  console.log(
    `[stage-default-models] Wrote ${MANIFEST_PATH} with ${manifestEntries.length} entries (source=${sourceLabel}).`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
