#!/usr/bin/env bun

/**
 * `bun run voice:create-profile` — build-time / fine-tune-time voice
 * profile creation.
 *
 * This is NOT a runtime UI. Profile creation happens at build time:
 *   - Invokes the I6 freeze pipeline (freeze-voice.mjs) to produce an
 *     ELZ2 v2 preset binary.
 *   - Emits an entry into `models/voice/profiles/catalog.json`.
 *   - Appends to `models/voice/CHANGELOG.md`.
 *
 * Usage:
 *   bun packages/app-core/scripts/voice-create-profile.mjs \
 *     --from packages/training/data/voice/samantha/audio/ \
 *     --name samantha \
 *     --display-name "Samantha" \
 *     --instruct "young adult female, warm, soft, neutral us-american"
 *
 * Flags:
 *   --from <dir>           Corpus directory (audio/*.wav + transcripts or
 *                          manifest.jsonl). Required.
 *   --name <id>            Profile id (path-safe, e.g. "samantha"). Required.
 *   --display-name <str>   Human-readable display name.
 *   --instruct <str>       VoiceDesign instruct string.
 *   --bundle <dir>         Bundle root for preset output. Default: auto.
 *   --max-seconds <n>      Max reference duration (default: 15).
 *   --skip-encode          Skip FFI encode (writes refText+instruct only).
 *   --dylib <path>         Override libelizainference dylib path.
 *   --dry-run              Plan only, don't write.
 *   --voice-models-dir <d> Override models/voice/ directory.
 *   --help                 Show this message.
 *
 * Exit codes:
 *   0  success
 *   1  failure
 *   2  bad CLI args
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_BUNDLE = path.join(
  homedir(),
  ".eliza",
  "local-inference",
  "models",
  "eliza-1-1_7b.bundle",
);
const DEFAULT_VOICE_MODELS_DIR = path.join(REPO_ROOT, "models", "voice");
const FREEZE_VOICE_SCRIPT = path.join(
  REPO_ROOT,
  "packages",
  "app-core",
  "scripts",
  "omnivoice-fuse",
  "freeze-voice.mjs",
);

function usage(code = 0) {
  console.log(
    [
      "Usage: bun packages/app-core/scripts/voice-create-profile.mjs [flags]",
      "",
      "Flags:",
      "  --from <dir>           Source corpus directory (required)",
      "  --name <id>            Profile id — path-safe (required)",
      "  --display-name <str>   Human display name",
      "  --instruct <str>       VoiceDesign instruct string",
      "  --bundle <dir>         Bundle root for preset output",
      "  --max-seconds <n>      Max reference seconds (default 15)",
      "  --skip-encode          Skip FFI encode (metadata-only preset)",
      "  --dylib <path>         Override libelizainference path",
      "  --dry-run              Print plan, don't write",
      "  --voice-models-dir <d> Override models/voice/ directory",
      "  --help                 This message",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    from: null,
    name: null,
    displayName: null,
    instruct: "",
    bundle: DEFAULT_BUNDLE,
    maxSeconds: 15,
    skipEncode: false,
    dylib: null,
    dryRun: false,
    voiceModelsDir: DEFAULT_VOICE_MODELS_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--from":
        args.from = argv[++i];
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--display-name":
        args.displayName = argv[++i];
        break;
      case "--instruct":
        args.instruct = argv[++i];
        break;
      case "--bundle":
        args.bundle = argv[++i];
        break;
      case "--max-seconds":
        args.maxSeconds = Number.parseFloat(argv[++i]);
        break;
      case "--skip-encode":
        args.skipEncode = true;
        break;
      case "--dylib":
        args.dylib = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--voice-models-dir":
        args.voiceModelsDir = argv[++i];
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        console.error(`[voice:create-profile] unknown flag: ${a}`);
        usage(2);
    }
  }
  if (!args.from) {
    console.error("[voice:create-profile] --from is required");
    usage(2);
  }
  if (!args.name) {
    console.error("[voice:create-profile] --name is required");
    usage(2);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(args.name)) {
    console.error(
      `[voice:create-profile] --name must be a path-safe segment (got: ${JSON.stringify(args.name)})`,
    );
    process.exit(2);
  }
  if (!Number.isFinite(args.maxSeconds) || args.maxSeconds <= 0) {
    console.error("[voice:create-profile] --max-seconds must be positive");
    process.exit(2);
  }
  args.displayName = args.displayName ?? args.name;
  return args;
}

// ---------------------------------------------------------------------------
// Catalog helpers (duplicated from voice-profile-routes.ts to keep this
// script dependency-free — no TypeScript import chain needed here).
// ---------------------------------------------------------------------------

const CATALOG_VERSION = 1;

function catalogPath(voiceModelsDir) {
  return path.join(voiceModelsDir, "profiles", "catalog.json");
}

async function readCatalog(voiceModelsDir) {
  const p = catalogPath(voiceModelsDir);
  if (!existsSync(p)) {
    return {
      version: CATALOG_VERSION,
      defaultProfileId: "samantha",
      profiles: [],
    };
  }
  try {
    const raw = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.profiles) parsed.profiles = [];
    if (!parsed.defaultProfileId) parsed.defaultProfileId = "samantha";
    return parsed;
  } catch {
    return {
      version: CATALOG_VERSION,
      defaultProfileId: "samantha",
      profiles: [],
    };
  }
}

async function writeCatalog(voiceModelsDir, catalog) {
  const p = catalogPath(voiceModelsDir);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(catalog, null, 2), "utf8");
  await fsp.rename(tmp, p);
}

// ---------------------------------------------------------------------------
// CHANGELOG helper
// ---------------------------------------------------------------------------

async function appendChangelog(
  voiceModelsDir,
  name,
  displayName,
  instruct,
  presetPath,
) {
  const changelogPath = path.join(voiceModelsDir, "CHANGELOG.md");
  const now = new Date().toISOString().slice(0, 10);
  let presetBytes = 0;
  try {
    const stat = await fsp.stat(presetPath);
    presetBytes = stat.size;
  } catch {
    // preset may not exist on dry-run
  }
  const entry = [
    "",
    `## voice-profiles / ${name}`,
    "",
    `### ${now} — initial create`,
    "",
    `- **Profile id:** \`${name}\``,
    `- **Display name:** ${displayName}`,
    `- **Instruct:** \`${instruct || "(empty — reference-audio only)"}\``,
    `- **Preset size:** ${presetBytes} bytes`,
    `- **Created by:** voice:create-profile`,
    "",
  ].join("\n");
  try {
    let existing = "";
    if (existsSync(changelogPath)) {
      existing = await fsp.readFile(changelogPath, "utf8");
    }
    await fsp.writeFile(changelogPath, existing + entry, "utf8");
  } catch (err) {
    console.warn(
      `[voice:create-profile] warning: could not append CHANGELOG: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[voice:create-profile] name=${args.name}`);
  console.log(`[voice:create-profile] display-name=${args.displayName}`);
  console.log(`[voice:create-profile] from=${args.from}`);
  console.log(
    `[voice:create-profile] instruct=${JSON.stringify(args.instruct)}`,
  );
  console.log(`[voice:create-profile] bundle=${args.bundle}`);
  console.log(`[voice:create-profile] max-seconds=${args.maxSeconds}`);
  console.log(`[voice:create-profile] skip-encode=${args.skipEncode}`);
  console.log(`[voice:create-profile] dry-run=${args.dryRun}`);

  // ------------------------------------------------------------------
  // Step 1: run the freeze pipeline
  // ------------------------------------------------------------------
  const presetPath = path.join(
    args.bundle,
    "cache",
    `voice-preset-${args.name}.bin`,
  );
  console.log(
    `\n[voice:create-profile] step 1: run freeze-voice.mjs → ${presetPath}`,
  );

  const freezeArgv = [
    "--voice",
    args.name,
    "--corpus",
    args.from,
    "--out",
    presetPath,
    "--bundle",
    args.bundle,
    "--instruct",
    args.instruct,
    "--max-seconds",
    String(args.maxSeconds),
  ];
  if (args.skipEncode) freezeArgv.push("--skip-encode");
  if (args.dylib) freezeArgv.push("--dylib", args.dylib);
  if (args.dryRun) freezeArgv.push("--dry-run");

  if (!existsSync(FREEZE_VOICE_SCRIPT)) {
    console.error(
      `[voice:create-profile] freeze-voice.mjs not found at ${FREEZE_VOICE_SCRIPT}`,
    );
    process.exit(1);
  }

  const result = spawnSync("bun", [FREEZE_VOICE_SCRIPT, ...freezeArgv], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(
      `[voice:create-profile] freeze-voice.mjs exited with code ${result.status}`,
    );
    process.exit(result.status ?? 1);
  }

  if (args.dryRun) {
    console.log(
      "\n[voice:create-profile] dry-run: skipping catalog + changelog writes.",
    );
    return;
  }

  // ------------------------------------------------------------------
  // Step 2: update catalog.json
  // ------------------------------------------------------------------
  console.log(
    `\n[voice:create-profile] step 2: update catalog → ${catalogPath(args.voiceModelsDir)}`,
  );
  const catalog = await readCatalog(args.voiceModelsDir);
  const now = new Date().toISOString();
  const existingIdx = catalog.profiles.findIndex((e) => e.id === args.name);
  const entry = {
    id: args.name,
    displayName: args.displayName,
    instruct: args.instruct,
    active: true,
    createdAt: existingIdx >= 0 ? catalog.profiles[existingIdx].createdAt : now,
  };
  if (existingIdx >= 0) {
    catalog.profiles[existingIdx] = entry;
    console.log(
      `[voice:create-profile] updated existing catalog entry for '${args.name}'`,
    );
  } else {
    catalog.profiles.push(entry);
    console.log(
      `[voice:create-profile] added catalog entry for '${args.name}'`,
    );
  }
  await writeCatalog(args.voiceModelsDir, catalog);
  console.log(`[voice:create-profile] catalog written.`);

  // ------------------------------------------------------------------
  // Step 3: append CHANGELOG.md
  // ------------------------------------------------------------------
  console.log(`\n[voice:create-profile] step 3: append CHANGELOG.md`);
  await appendChangelog(
    args.voiceModelsDir,
    args.name,
    args.displayName,
    args.instruct,
    presetPath,
  );

  console.log(
    `\n[voice:create-profile] done. Profile '${args.name}' is ready.`,
  );
  console.log(`  Preset: ${presetPath}`);
  console.log(`  Catalog: ${catalogPath(args.voiceModelsDir)}`);
  console.log(`  Activate: POST /v1/voice/profiles/${args.name}/activate`);
}

main().catch((err) => {
  console.error(`[voice:create-profile] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
