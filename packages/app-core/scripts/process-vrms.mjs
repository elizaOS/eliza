#!/usr/bin/env node
/**
 * Process VRM avatars from characters/vrm: gzip for shipping.
 *
 * Replaces VRMs in packages/app/public/vrms and packages/app/public_src/vrms with
 * gzipped versions of the character models.
 *
 * Note: gltf-transform optimize/meshopt/draco are intentionally NOT used because
 * they strip or reindex VRM extensions (VRMC_vrm, VRMC_springBone,
 * VRMC_materials_mtoon), breaking VRM loading. Gzip alone gives ~40% compression
 * on these files, and the marginal benefit of mesh compression (~0.6MB/file) is
 * not worth the complexity of preserving VRM extension integrity.
 *
 * Usage:
 *   node scripts/process-vrms.mjs
 *   node scripts/process-vrms.mjs --placeholders-only # only fix previews/backgrounds
 *   node scripts/process-vrms.mjs --dry-run
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const CHARACTERS_VRM = join(ROOT, "apps", "app", "characters", "vrm");
const PUBLIC_VRMS = join(ROOT, "apps", "app", "public", "vrms");
const PUBLIC_SRC_VRMS = join(
  ROOT,
  "eliza",
  "apps",
  "app-companion",
  "public_src",
  "vrms",
);
const TAG = "[process-vrms]";

// Character name -> eliza index (1-based). Order determines avatar order in UI.
const CHARACTER_TO_INDEX = [
  ["Chen", 1],
  ["Jin", 2],
  ["Kei", 3],
  ["Momo", 4],
  ["Rin", 5],
  ["Ryu", 6],
  ["Satoshi", 7],
  ["Yuki", 8],
];

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let placeholdersOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--placeholders-only") {
      placeholdersOnly = true;
    }
  }
  return { dryRun, placeholdersOnly };
}

function processVrm(srcPath, destBaseName, dryRun) {
  if (dryRun) {
    console.log(`${TAG} [dry-run] ${srcPath} -> ${destBaseName}.vrm.gz`);
    return;
  }

  const rawBytes = readFileSync(srcPath);
  const rawMB = (rawBytes.length / 1024 / 1024).toFixed(1);

  // Gzip for public (shipped assets)
  const gzipPath = join(PUBLIC_VRMS, `${destBaseName}.vrm.gz`);
  const gzipped = gzipSync(rawBytes, { level: 9 });
  writeFileSync(gzipPath, gzipped);
  const gzMB = (gzipped.length / 1024 / 1024).toFixed(1);

  // Copy raw to public_src (for screenshotter / dev)
  const publicSrcDest = join(PUBLIC_SRC_VRMS, `${destBaseName}.vrm`);
  cpSync(srcPath, publicSrcDest, { force: true });

  console.log(`${TAG} ${rawMB}MB -> ${gzMB}MB gzipped`);
}

function main() {
  const { dryRun, placeholdersOnly } = parseArgs();

  if (!placeholdersOnly && !existsSync(CHARACTERS_VRM)) {
    console.error(
      `${TAG} ERROR: characters/vrm not found at ${CHARACTERS_VRM}`,
    );
    process.exit(1);
  }

  const available = placeholdersOnly
    ? []
    : readdirSync(CHARACTERS_VRM).filter((f) => f.endsWith(".vrm"));
  if (!placeholdersOnly && available.length === 0) {
    console.error(`${TAG} ERROR: no .vrm files in ${CHARACTERS_VRM}`);
    process.exit(1);
  }

  console.log(
    `${TAG} Processing ${placeholdersOnly ? "placeholders only" : `${available.length} VRMs from characters/vrm`} (dryRun=${dryRun})`,
  );

  // Remove old VRMs and previews/backgrounds not in our character set (eliza-1..8)
  const keepIds = new Set(CHARACTER_TO_INDEX.map(([, i]) => i));
  const dirsToClean = [
    PUBLIC_VRMS,
    PUBLIC_SRC_VRMS,
    join(PUBLIC_VRMS, "previews"),
    join(PUBLIC_VRMS, "backgrounds"),
    join(PUBLIC_SRC_VRMS, "previews"),
    join(PUBLIC_SRC_VRMS, "backgrounds"),
  ];
  for (const dir of dirsToClean) {
    if (existsSync(dir) && !dryRun) {
      for (const f of readdirSync(dir)) {
        const m = f.match(/^eliza-(\d+)\.(vrm|png)(\.gz)?$/);
        if (m && !keepIds.has(Number(m[1]))) {
          const p = join(dir, f);
          try {
            unlinkSync(p);
            console.log(`${TAG} Removed obsolete ${f}`);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  mkdirSync(PUBLIC_VRMS, { recursive: true });
  mkdirSync(join(PUBLIC_VRMS, "previews"), { recursive: true });
  mkdirSync(join(PUBLIC_VRMS, "backgrounds"), { recursive: true });
  mkdirSync(PUBLIC_SRC_VRMS, { recursive: true });
  mkdirSync(join(PUBLIC_SRC_VRMS, "previews"), { recursive: true });
  mkdirSync(join(PUBLIC_SRC_VRMS, "backgrounds"), { recursive: true });

  let processed = 0;
  if (!placeholdersOnly) {
    for (const [charName, index] of CHARACTER_TO_INDEX) {
      const vrmFile = `${charName}.vrm`;
      const srcPath = join(CHARACTERS_VRM, vrmFile);
      if (!existsSync(srcPath)) {
        console.warn(`${TAG} Skipping ${vrmFile} (not found)`);
        continue;
      }
      const destBaseName = `eliza-${index}`;
      console.log(`${TAG} ${charName}.vrm -> ${destBaseName}.vrm.gz`);
      processVrm(srcPath, destBaseName, dryRun);
      processed += 1;
    }
  } else {
    processed = CHARACTER_TO_INDEX.length;
  }

  // Ensure previews and backgrounds exist for all avatars (copy from first existing if missing)
  if (processed > 0 && !dryRun) {
    let srcPreview = null;
    let srcBg = null;
    for (const [, index] of CHARACTER_TO_INDEX) {
      const p = join(PUBLIC_VRMS, "previews", `eliza-${index}.png`);
      const b = join(PUBLIC_VRMS, "backgrounds", `eliza-${index}.png`);
      if (!srcPreview && existsSync(p)) srcPreview = p;
      if (!srcBg && existsSync(b)) srcBg = b;
      if (srcPreview && srcBg) break;
    }
    for (const [, index] of CHARACTER_TO_INDEX) {
      const dstPreview = join(PUBLIC_VRMS, "previews", `eliza-${index}.png`);
      const dstBg = join(PUBLIC_VRMS, "backgrounds", `eliza-${index}.png`);
      if (!existsSync(dstPreview) && srcPreview) {
        cpSync(srcPreview, dstPreview);
        console.log(`${TAG} Copied placeholder preview eliza-${index}.png`);
      }
      if (!existsSync(dstBg) && srcBg) {
        cpSync(srcBg, dstBg);
        console.log(`${TAG} Copied placeholder background eliza-${index}.png`);
      }
    }
  }

  console.log(`${TAG} Processed ${processed} VRMs`);
  if (processed > 0 && !dryRun) {
    console.log(
      `${TAG} Output: public/vrms/*.vrm.gz (shipped), public_src/vrms/*.vrm (archived)`,
    );
  }
}

main();
