#!/usr/bin/env node
/**
 * Stages the published first-run chat and voice artifacts into Android assets.
 * The manifest identifies each architecture-independent file for extraction
 * into the local-inference state directory. Builders can opt out when the
 * roughly 4.8 GiB offline payload is unsuitable for their image contract.
 */

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
const FIRST_RUN_BUNDLE_SLUG = "e2b";

/**
 * Models to bundle. IDs match `MODEL_CATALOG` entries in
 * eliza/packages/app-core/src/services/local-inference/catalog.ts so the
 * runtime registry treats them as known catalog models, not orphans.
 *
 * The Android image bundles the entry chat tier so first boot can work offline.
 *
 * Sizes are sanity-checked at download time. If HuggingFace serves
 * a smaller file (e.g. partial download, repo deleted, replaced) the
 * staging step fails loudly rather than shipping a broken APK.
 */
const CHAT_MODEL_ELIZA_1_MOBILE = {
  id: "eliza-1-2b",
  displayName: "eliza-1-2B",
  hfRepo: "elizaos/eliza-1",
  hfPath: `bundles/${FIRST_RUN_BUNDLE_SLUG}/text/eliza-1-${FIRST_RUN_BUNDLE_SLUG}-128k.gguf`,
  ggufFile: `text/eliza-1-${FIRST_RUN_BUNDLE_SLUG}-128k.gguf`,
  expectedMinBytes: 4_500_000_000,
  expectedMaxBytes: 5_500_000_000,
  role: "chat",
};

// Kokoro-82M voice — the on-device TTS voice. Without it the bundle has no
// tts/ model, so the runtime can't synthesize and the app falls back to the
// platform TextToSpeech (the "android voice"). Kokoro is the small/fast voice
// (~167 MB acoustic GGUF + a ~0.5 MB speaker preset), so bundling it keeps
// first-boot voice working offline with no runtime download. Staged into
// tts/kokoro/, exactly where the fused FFI's Kokoro loader (and
// ElizaBionicInferenceServer.tts()) resolves it.
const VOICE_MODEL_KOKORO = {
  id: "eliza-1-kokoro",
  displayName: "Eliza-1 Voice (Kokoro)",
  hfRepo: "elizaos/eliza-1",
  hfPath: `bundles/${FIRST_RUN_BUNDLE_SLUG}/tts/kokoro/kokoro-82m-v1_0.gguf`,
  ggufFile: "tts/kokoro/kokoro-82m-v1_0.gguf",
  expectedMinBytes: 150 * 1024 * 1024,
  expectedMaxBytes: 200 * 1024 * 1024,
  role: "tts",
};

const VOICE_PRESET_KOKORO = {
  id: "eliza-1-kokoro-voice-af-sam",
  displayName: "Eliza-1 Voice preset (af_sam)",
  hfRepo: "elizaos/eliza-1",
  hfPath: "voice/kokoro/voices/af_sam.bin",
  ggufFile: "tts/kokoro/af_sam.bin",
  expectedMinBytes: 256 * 1024,
  expectedMaxBytes: 1024 * 1024,
  role: "tts",
};

export const DEFAULT_MODELS = [
  CHAT_MODEL_ELIZA_1_MOBILE,
  VOICE_MODEL_KOKORO,
  VOICE_PRESET_KOKORO,
];

export function resolveDefaultModelsAssetsDir(root = repoRoot) {
  return path.join(
    root,
    "packages",
    "app-core",
    "platforms",
    "android",
    "app",
    "src",
    "main",
    "assets",
    "agent",
    "models",
  );
}

const ASSETS_MODELS_DIR = resolveDefaultModelsAssetsDir(repoRoot);

const MANIFEST_PATH = path.join(ASSETS_MODELS_DIR, "manifest.json");

function hfResolveUrl(repo, file) {
  // The /resolve/main/ path serves the LFS-hydrated file, not the
  // pointer. /raw/ would serve the LFS pointer text and break us.
  const encodedPath = file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://huggingface.co/${repo}/resolve/main/${encodedPath}?download=true`;
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
    const url = hfResolveUrl(model.hfRepo, model.hfPath ?? model.ggufFile);
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
