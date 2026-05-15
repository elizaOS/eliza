#!/usr/bin/env node
/**
 * validate-bundle-plan.mjs — WS10 prep validator.
 *
 * Walks `docs/ELIZA_1_GGUF_PLATFORM_PLAN.json` and
 * `docs/ELIZA_1_BUNDLE_EXTRAS.json`, and asserts every per-tier entry has a
 * corresponding catalog entry in
 * `packages/shared/src/local-inference/catalog.ts`.
 *
 * Surfaces gaps as actionable WS2 / WS3 / WS5 follow-ups rather than failing
 * the whole script. The script's exit code is 0 when the structural
 * invariants hold (every JSON well-formed; every plan tier maps to a tier id
 * the catalog knows about); it prints a non-empty `gaps` list when a per-tier
 * file is named in the plan but no corresponding catalog component slot
 * exists yet. Exit non-zero only on hard schema violations (missing keys,
 * tier id mismatch, etc.).
 *
 * Usage:
 *   node scripts/validate-bundle-plan.mjs [--json]
 *
 * Exits 0 on a clean structural pass (even with surfaced gaps); 1 on a hard
 * schema error.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

const PLAN_PATH = path.join(
  REPO_ROOT,
  "docs",
  "ELIZA_1_GGUF_PLATFORM_PLAN.json",
);
const EXTRAS_PATH = path.join(REPO_ROOT, "docs", "ELIZA_1_BUNDLE_EXTRAS.json");
const CATALOG_PATH = path.join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "local-inference",
  "catalog.ts",
);

const JSON_OUT = process.argv.includes("--json");

/** @type {{ kind: "error" | "gap"; where: string; message: string }[]} */
const findings = [];
let hardErrors = 0;

function err(where, message) {
  hardErrors += 1;
  findings.push({ kind: "error", where, message });
}

function gap(where, message) {
  findings.push({ kind: "gap", where, message });
}

/**
 * Asserts that an imagegen artifact entry has either a real download URL
 * (HTTP/HTTPS) or an explicit `staged: true` marker with a build plan.
 * Entries that have neither are publishing-pipeline gaps: the validator
 * cannot prove the file will exist at install time.
 *
 * Surfaces missing URLs as hard errors so CI fails until either the
 * upstream HF URL is known or the in-house build plan is committed.
 */
function assertPublishingState(where, entry) {
  const hasUrl =
    typeof entry?.url === "string" && /^https?:\/\//i.test(entry.url.trim());
  const staged = entry?.staged === true;
  if (!hasUrl && !staged) {
    err(
      where,
      "missing publishing state: entry needs either a `url` (https://...) or `staged: true` with a `buildPlan`",
    );
    return;
  }
  if (hasUrl && staged) {
    err(
      where,
      "ambiguous publishing state: entry is both `staged: true` and has a `url`. Pick one — staged entries are not yet downloadable.",
    );
    return;
  }
  if (staged) {
    const plan = entry.buildPlan;
    if (!plan || typeof plan !== "object") {
      err(where, "staged entry missing `buildPlan` object");
      return;
    }
    for (const key of ["tool", "source", "command"]) {
      if (typeof plan[key] !== "string" || !plan[key].trim()) {
        err(where, `staged entry buildPlan.${key} must be a non-empty string`);
        return;
      }
    }
  }
  if (hasUrl && entry.sha256 !== undefined) {
    if (
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(entry.sha256.trim())
    ) {
      gap(
        where,
        "optional `sha256` field is present but not a 64-char hex digest; the installer will skip verification (consider fixing or removing)",
      );
    }
  }
}

/**
 * Vision mmproj entries flagged `staged: true` must carry a
 * `stagedBuild` block documenting how the build pipeline produces the
 * file. The block ties the staged GGUF back to a concrete source model
 * + build step so neither agents nor the publish pipeline can land a
 * silent placeholder.
 */
function assertVisionStagedBuild(where, entry) {
  const sb = entry?.stagedBuild;
  if (!sb || typeof sb !== "object") {
    err(where, "vision entry has `staged: true` but no `stagedBuild` block");
    return;
  }
  for (const key of ["script", "step", "sourceModel", "rationale"]) {
    if (typeof sb[key] !== "string" || !sb[key].trim()) {
      err(
        where,
        `stagedBuild.${key} must be a non-empty string (staged vision entries must document the build step)`,
      );
    }
  }
}

function readJson(absPath, label) {
  if (!fs.existsSync(absPath)) {
    err(label, `file missing: ${absPath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (e) {
    err(label, `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const plan = readJson(PLAN_PATH, "plan");
const extras = readJson(EXTRAS_PATH, "extras");

/**
 * The catalog is TypeScript. Rather than parse it, we read the
 * ELIZA_1_TIER_IDS literal block and capture the per-tier feature flags
 * (`hasEmbedding`, `hasVision`). This is enough to answer "is this tier
 * registered, and does the catalog claim it supports vision".
 */
function parseCatalogTierFacts() {
  if (!fs.existsSync(CATALOG_PATH)) {
    err("catalog", `file missing: ${CATALOG_PATH}`);
    return null;
  }
  const src = fs.readFileSync(CATALOG_PATH, "utf8");
  const tierIdsMatch = src.match(
    /ELIZA_1_TIER_IDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const;/,
  );
  if (!tierIdsMatch) {
    err("catalog", "could not locate ELIZA_1_TIER_IDS array literal");
    return null;
  }
  const tierIds = Array.from(
    tierIdsMatch[1].matchAll(/"([^"]+)"/g),
    (m) => m[1],
  );

  const facts = new Map();
  for (const tierId of tierIds) {
    facts.set(tierId, { hasEmbedding: false, hasVision: false });
  }
  const specsMatch = src.match(
    /TIER_SPECS:\s*Readonly<[\s\S]*?>\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (specsMatch) {
    const block = specsMatch[1];
    const tierBlocks = block.split(/"eliza-1-[^"]+":\s*\{/g);
    const tierHeaders = Array.from(
      block.matchAll(/"(eliza-1-[^"]+)":\s*\{/g),
      (m) => m[1],
    );
    for (let i = 0; i < tierHeaders.length; i += 1) {
      const tierId = tierHeaders[i];
      const body = tierBlocks[i + 1] ?? "";
      const cutoff = body.indexOf("\n  },");
      const tierBody = cutoff >= 0 ? body.slice(0, cutoff) : body;
      const hasEmbedding = /hasEmbedding:\s*true/.test(tierBody);
      const hasVision = /hasVision:\s*true/.test(tierBody);
      facts.set(tierId, { hasEmbedding, hasVision });
    }
  } else {
    err(
      "catalog",
      "could not locate TIER_SPECS object; per-tier hasVision facts unknown",
    );
  }
  return facts;
}

const catalogFacts = parseCatalogTierFacts();

/* ------------------------------------------------------------------ */
/* Plan invariants                                                     */
/* ------------------------------------------------------------------ */

function tierIdFor(planKey) {
  // Plan keys are bare ("0_8b", "2b", "27b-256k"); catalog keys are
  // prefixed ("eliza-1-0_8b").
  return `eliza-1-${planKey}`;
}

if (plan && catalogFacts) {
  for (const planKey of Object.keys(plan)) {
    const catalogId = tierIdFor(planKey);
    if (!catalogFacts.has(catalogId)) {
      err("plan", `tier "${planKey}" has no catalog entry "${catalogId}"`);
      continue;
    }
    const entry = plan[planKey];
    if (!Array.isArray(entry.required_files)) {
      err("plan", `tier "${planKey}": required_files is not an array`);
      continue;
    }
    const claimsVision = entry.required_files.some(
      (f) => typeof f === "string" && f.startsWith("vision/mmproj-"),
    );
    const catalogHasVision = catalogFacts.get(catalogId)?.hasVision === true;
    if (claimsVision && !catalogHasVision) {
      gap(
        "plan",
        `tier "${planKey}" lists a vision mmproj but catalog TIER_SPECS["${catalogId}"].hasVision is false (WS2 follow-up: flip hasVision in catalog.ts or drop the mmproj entry from the plan)`,
      );
    }
    if (!claimsVision && catalogHasVision) {
      gap(
        "plan",
        `tier "${planKey}" has no vision mmproj but catalog TIER_SPECS["${catalogId}"].hasVision is true (WS2 follow-up)`,
      );
    }
  }
  for (const catalogId of catalogFacts.keys()) {
    const planKey = catalogId.slice("eliza-1-".length);
    if (!plan[planKey]) {
      err("plan", `catalog tier "${catalogId}" has no plan entry "${planKey}"`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Extras invariants                                                   */
/* ------------------------------------------------------------------ */

if (extras && catalogFacts) {
  const imagegenTiers = extras.imagegen?.perTier ?? {};
  const visionTiers = extras.vision?.perTier ?? {};

  for (const tierId of Object.keys(imagegenTiers)) {
    if (!catalogFacts.has(tierId)) {
      err(
        "extras.imagegen",
        `unknown tier id "${tierId}" — not in catalog ELIZA_1_TIER_IDS`,
      );
      continue;
    }
    const entry = imagegenTiers[tierId];
    if (!entry?.default?.file) {
      err("extras.imagegen", `tier "${tierId}" missing default.file`);
    } else {
      assertPublishingState(`extras.imagegen.${tierId}.default`, entry.default);
    }
    if (!Array.isArray(entry?.optional)) {
      err("extras.imagegen", `tier "${tierId}" optional is not an array`);
    } else {
      for (let i = 0; i < entry.optional.length; i += 1) {
        const opt = entry.optional[i];
        const optId = typeof opt?.id === "string" ? opt.id : `#${i}`;
        if (!opt?.file) {
          err(
            "extras.imagegen",
            `tier "${tierId}" optional "${optId}" missing file`,
          );
          continue;
        }
        assertPublishingState(
          `extras.imagegen.${tierId}.optional.${optId}`,
          opt,
        );
      }
    }
  }

  for (const tierId of Object.keys(visionTiers)) {
    if (!catalogFacts.has(tierId)) {
      err(
        "extras.vision",
        `unknown tier id "${tierId}" — not in catalog ELIZA_1_TIER_IDS`,
      );
      continue;
    }
    const entry = visionTiers[tierId];
    if (typeof entry?.estimatedSizeBytes !== "number") {
      err(
        "extras.vision",
        `tier "${tierId}" missing estimatedSizeBytes (number)`,
      );
    }
    // Staged vision entries must carry a stagedBuild block. Non-staged
    // entries are mirrored from upstream HF mmproj GGUFs at install time
    // (the catalog's bundlePath helpers derive those URLs) — no extra
    // validation needed here for the mirrored path.
    if (entry?.staged === true) {
      assertVisionStagedBuild(`extras.vision.${tierId}`, entry);
    }
  }

  // Cross-check: every catalog tier should have a vision entry in extras
  // (the runtime budget table depends on it). Surface as gap, not error.
  for (const tierId of catalogFacts.keys()) {
    if (!visionTiers[tierId]) {
      gap(
        "extras.vision",
        `catalog tier "${tierId}" missing vision size estimate in ELIZA_1_BUNDLE_EXTRAS.json (WS3 follow-up: add when arbiter resident-budget math is wired)`,
      );
    }
    if (!imagegenTiers[tierId]) {
      gap(
        "extras.imagegen",
        `catalog tier "${tierId}" missing image-gen default in ELIZA_1_BUNDLE_EXTRAS.json (WS5 follow-up: confirm tier-default diffusion choice)`,
      );
    }
  }

  // OCR + person-detect block sanity
  if (
    !Array.isArray(extras.ocr?.components) ||
    extras.ocr.components.length === 0
  ) {
    err("extras.ocr", "ocr.components missing or empty");
  }
  if (
    !Array.isArray(extras.personDetect?.components) ||
    extras.personDetect.components.length === 0
  ) {
    err("extras.personDetect", "personDetect.components missing or empty");
  }
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const errors = findings.filter((f) => f.kind === "error");
const gaps = findings.filter((f) => f.kind === "gap");

if (JSON_OUT) {
  process.stdout.write(
    `${JSON.stringify({ errors, gaps, hardErrors }, null, 2)}\n`,
  );
} else {
  if (errors.length > 0) {
    console.log("=== Bundle plan / extras: HARD ERRORS ===");
    for (const f of errors) console.log(`  [${f.where}] ${f.message}`);
  } else {
    console.log("=== Bundle plan / extras: structural pass ===");
  }
  if (gaps.length > 0) {
    console.log("");
    console.log(`=== Surfaced gaps (informational, ${gaps.length}) ===`);
    for (const f of gaps) console.log(`  [${f.where}] ${f.message}`);
  }
  console.log("");
  console.log(
    `summary: hardErrors=${hardErrors} gaps=${gaps.length} status=${hardErrors === 0 ? "OK" : "FAIL"}`,
  );
}

process.exit(hardErrors === 0 ? 0 : 1);
