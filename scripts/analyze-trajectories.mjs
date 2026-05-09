#!/usr/bin/env node
/**
 * Analyze JSON trajectory files written by trajectory-recorder.ts.
 *
 * Reports per-suite:
 *   - file count, stage count
 *   - total prompt/completion/cache(read|creation) tokens
 *   - cache hit % = cacheReadInputTokens / promptTokens
 *   - cost (sum of model.costUsd)
 *   - duplicate prompt-section detection via stable-hash buckets
 *   - longest repeated substrings across all assembled prompts
 *
 * Usage:  node scripts/analyze-trajectories.mjs <trajectory-root>
 *
 * The root may be either a single agent-id directory OR a parent that contains
 * agent-id subdirs.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.argv[2];
if (!root) {
  console.error("Usage: analyze-trajectories.mjs <dir>");
  process.exit(2);
}

function* walkJson(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJson(p);
    } else if (e.isFile() && e.name.endsWith(".json")) {
      yield p;
    }
  }
}

const trajectories = [];
for (const file of walkJson(root)) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j.stages) continue;
    trajectories.push({ file, j });
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
  }
}

if (trajectories.length === 0) {
  console.error(`No trajectory JSONs under ${root}`);
  process.exit(1);
}

// Aggregates
let totalPrompt = 0;
let totalCompletion = 0;
let totalCacheRead = 0;
let totalCacheCreate = 0;
let totalCost = 0;
let modelCallCount = 0;
const modelCounts = new Map();
const promptSections = []; // { hash, content, file, role, stage, msgIndex }
const fullPrompts = []; // {file, full}

const SECTION_SPLIT = /\n\s*\n+/; // blank-line delimited
function hashContent(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

for (const { file, j } of trajectories) {
  for (const stage of j.stages ?? []) {
    if (!stage.model) continue;
    modelCallCount++;
    const usage = stage.model.usage ?? {};
    totalPrompt += usage.promptTokens ?? 0;
    totalCompletion += usage.completionTokens ?? 0;
    totalCacheRead += usage.cacheReadInputTokens ?? 0;
    totalCacheCreate += usage.cacheCreationInputTokens ?? 0;
    totalCost += stage.model.costUsd ?? 0;
    const modelName = `${stage.model.provider ?? "?"}::${stage.model.modelName ?? stage.model.modelType ?? "?"}`;
    modelCounts.set(modelName, (modelCounts.get(modelName) ?? 0) + 1);

    const messages = Array.isArray(stage.model.messages)
      ? stage.model.messages
      : [];
    let assembled = "";
    messages.forEach((m, mi) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      assembled += `\n[${m.role}]\n${content}`;
      // Split into sections by blank-line and hash each
      for (const section of content.split(SECTION_SPLIT)) {
        const trimmed = section.trim();
        if (trimmed.length < 80) continue; // ignore short
        promptSections.push({
          hash: hashContent(trimmed),
          length: trimmed.length,
          content: trimmed,
          file: path.basename(file),
          role: m.role,
          stage: stage.kind,
          msgIndex: mi,
        });
      }
    });
    fullPrompts.push({ file: path.basename(file), full: assembled });
  }
}

// Bucket sections by hash → identify duplicates
const sectionBuckets = new Map();
for (const s of promptSections) {
  if (!sectionBuckets.has(s.hash)) {
    sectionBuckets.set(s.hash, { hash: s.hash, length: s.length, count: 0, sample: s.content, occurrences: [] });
  }
  const b = sectionBuckets.get(s.hash);
  b.count += 1;
  b.occurrences.push({ file: s.file, role: s.role, stage: s.stage, msgIndex: s.msgIndex });
}
const duplicatedSections = [...sectionBuckets.values()]
  .filter((b) => b.count >= 2)
  .sort((a, b) => b.length * b.count - a.length * a.count);

// Print report
const cacheHitPct = totalPrompt > 0 ? (totalCacheRead / totalPrompt) * 100 : 0;
console.log(`\n══ Trajectory Analysis: ${root} ══`);
console.log(`Trajectories: ${trajectories.length}  ModelCalls: ${modelCallCount}`);
console.log(`Models used:`);
for (const [m, c] of modelCounts) console.log(`  ${m}: ${c} calls`);
console.log(`\nTokens:`);
console.log(`  prompt           = ${totalPrompt.toLocaleString()}`);
console.log(`  completion       = ${totalCompletion.toLocaleString()}`);
console.log(`  cache(read)      = ${totalCacheRead.toLocaleString()}  ${cacheHitPct.toFixed(2)}%  hit-rate`);
console.log(`  cache(create)    = ${totalCacheCreate.toLocaleString()}`);
console.log(`  cost USD         = $${totalCost.toFixed(4)}`);

console.log(`\nDuplicated prompt sections (>=80 chars, hashed by content, count >=2):`);
if (duplicatedSections.length === 0) {
  console.log(`  (none)`);
} else {
  duplicatedSections.slice(0, 10).forEach((b, i) => {
    console.log(`\n  [#${i + 1}] hash=${b.hash}  length=${b.length}  duplicates=${b.count}`);
    console.log(`    occurrences: ${b.occurrences.slice(0, 4).map((o) => `${o.file}/${o.role}#${o.msgIndex}`).join("  ")}${b.occurrences.length > 4 ? "  ..." : ""}`);
    const preview = b.sample.length > 200 ? `${b.sample.slice(0, 200)}…` : b.sample;
    console.log(`    sample: ${preview.replace(/\n/g, "\\n")}`);
  });
  if (duplicatedSections.length > 10) {
    console.log(`\n  …+${duplicatedSections.length - 10} more duplicate sections`);
  }
}

console.log(`\nDistinct sections seen: ${sectionBuckets.size}`);
console.log(`Total section occurrences: ${promptSections.length}`);
const bytesTotal = promptSections.reduce((a, b) => a + b.length, 0);
const bytesUnique = [...sectionBuckets.values()].reduce((a, b) => a + b.length, 0);
const dupBytes = bytesTotal - bytesUnique;
const dupPct = bytesTotal > 0 ? (dupBytes / bytesTotal) * 100 : 0;
console.log(
  `Approx duplicated prompt bytes: ${dupBytes.toLocaleString()} / ${bytesTotal.toLocaleString()} = ${dupPct.toFixed(1)}%`,
);

if (process.argv.includes("--dump-first")) {
  console.log(`\n══ First trajectory full prompt ══`);
  console.log(fullPrompts[0].full);
}
