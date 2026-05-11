#!/usr/bin/env node
/**
 * lifeops-action-collisions — Wave 2-A.
 *
 * Loads the prompt-inventory manifest, pulls every distinct action
 * description, and computes pairwise cosine similarity over TF-IDF vectors
 * built from a simple bag-of-words tokenization (no LLM call). Any pair
 * scoring ≥ COLLISION_THRESHOLD lands in
 * `docs/audits/lifeops-2026-05-11/action-collisions.md` and the structured
 * counterpart `action-collisions.json`.
 *
 * The TF-IDF is intentionally cheap:
 *   - tokens are alphanumeric, lowercased, deduplicated stopwords
 *   - TF = raw count (capped at 5 to muzzle repeated boilerplate)
 *   - IDF = log(N / df) over the population of action descriptions
 *   - vectors are L2-normalized
 *   - cosine = dot product (since both sides are unit vectors)
 *
 * Output: NO HTML — Markdown + JSON only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "..", "..");
const AUDIT_DIR = join(REPO_ROOT, "docs", "audits", "lifeops-2026-05-11");
const MANIFEST_PATH = join(AUDIT_DIR, "prompts-manifest.json");
const MD_OUT = join(AUDIT_DIR, "action-collisions.md");
const JSON_OUT = join(AUDIT_DIR, "action-collisions.json");

const COLLISION_THRESHOLD = Number(process.env.LIFEOPS_COLLISION_THRESHOLD ?? "0.75");
// Show this many "near-miss" pairs (in the [NEAR_MISS_FLOOR, threshold)
// band) at the bottom of the markdown — useful when the strict threshold
// turns up nothing because action descriptions in this codebase are short.
const NEAR_MISS_FLOOR = Number(process.env.LIFEOPS_NEAR_MISS_FLOOR ?? "0.5");
const NEAR_MISS_LIMIT = Number(process.env.LIFEOPS_NEAR_MISS_LIMIT ?? "10");

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "use",
  "used",
  "uses",
  "via",
  "was",
  "with",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "will",
  "you",
  "your",
  "user",
  "users",
  "agent",
  "action",
  "actions",
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `manifest not found at ${MANIFEST_PATH}. Run \`bun run lifeops:prompts:inventory\` first.`,
    );
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

// Collect one row per distinct action+file combination — we keep the
// file-path so collisions between the same logical action declared in two
// files (helper + spec-only mirror, for example) still show up.
function gatherActionDescriptions(manifest) {
  const rows = [];
  for (const p of manifest.prompts) {
    if (p.kind !== "action-description") continue;
    rows.push({
      id: p.id,
      actionName: p.extras?.actionName ?? p.id,
      filePath: p.filePath,
      text: p.text,
      tokens: tokenize(p.text),
      compressedText: p.compressedText ?? null,
    });
  }
  return rows;
}

function buildTfIdf(rows) {
  const docFreq = new Map();
  for (const row of rows) {
    const seen = new Set();
    for (const tok of row.tokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
    }
  }
  const N = Math.max(rows.length, 1);
  const idf = new Map();
  for (const [tok, df] of docFreq.entries()) {
    idf.set(tok, Math.log(N / df));
  }
  const vectors = rows.map((row) => {
    const tf = new Map();
    for (const tok of row.tokens) {
      tf.set(tok, Math.min((tf.get(tok) ?? 0) + 1, 5));
    }
    const vec = new Map();
    let norm = 0;
    for (const [tok, count] of tf.entries()) {
      const idfVal = idf.get(tok) ?? 0;
      if (idfVal === 0) continue;
      const w = count * idfVal;
      vec.set(tok, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (const [tok, w] of vec.entries()) {
        vec.set(tok, w / norm);
      }
    }
    return vec;
  });
  return { vectors, idf };
}

function cosine(a, b) {
  // Iterate over the smaller map; both vectors are L2-normalized so the dot
  // product is the cosine.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [tok, w] of small.entries()) {
    const other = large.get(tok);
    if (other) sum += w * other;
  }
  return sum;
}

function computeCollisions(rows, vectors) {
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      // Skip pairs that share the same action name + only differ by file —
      // those are duplicate declarations of the same action, not a genuine
      // collision between two surface-distinct actions.
      if (rows[i].actionName === rows[j].actionName) continue;
      const sim = cosine(vectors[i], vectors[j]);
      if (sim >= COLLISION_THRESHOLD) {
        pairs.push({
          a: rows[i],
          b: rows[j],
          similarity: sim,
        });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}

function renderMarkdown(pairs, rows) {
  const lines = [];
  lines.push("# Action description collisions");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Threshold: cosine ≥ ${COLLISION_THRESHOLD.toFixed(2)}`);
  lines.push(`Population: ${rows.length} action descriptions`);
  lines.push(`Pairs above threshold: ${pairs.length}`);
  lines.push("");
  lines.push(
    "Each row below is two actions whose `description` strings share enough TF-IDF mass to risk planner-routing collisions. Tighten the wording where appropriate (or merge / split the actions).",
  );
  lines.push("");
  if (pairs.length === 0) {
    lines.push("_No collisions at or above the configured threshold._");
    lines.push("");
    return lines.join("\n");
  }
  let idx = 1;
  for (const pair of pairs) {
    lines.push(
      `## ${idx}. \`${pair.a.actionName}\` × \`${pair.b.actionName}\` — similarity ${pair.similarity.toFixed(3)}`,
    );
    lines.push("");
    lines.push(`- A: \`${pair.a.actionName}\` — \`${pair.a.filePath}\``);
    lines.push(`- B: \`${pair.b.actionName}\` — \`${pair.b.filePath}\``);
    lines.push("");
    lines.push("### A.description");
    lines.push("```");
    lines.push(pair.a.text);
    lines.push("```");
    lines.push("");
    lines.push("### B.description");
    lines.push("```");
    lines.push(pair.b.text);
    lines.push("```");
    lines.push("");
    idx++;
  }
  return lines.join("\n");
}

function main() {
  const manifest = loadManifest();
  const rows = gatherActionDescriptions(manifest);
  const { vectors } = buildTfIdf(rows);
  const pairs = computeCollisions(rows, vectors);
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(MD_OUT, renderMarkdown(pairs, rows));
  const jsonPayload = {
    schemaVersion: "lifeops-action-collisions-v1",
    generatedAt: new Date().toISOString(),
    threshold: COLLISION_THRESHOLD,
    population: rows.length,
    pairs: pairs.map((p) => ({
      similarity: Number(p.similarity.toFixed(4)),
      a: {
        actionName: p.a.actionName,
        id: p.a.id,
        filePath: p.a.filePath,
      },
      b: {
        actionName: p.b.actionName,
        id: p.b.id,
        filePath: p.b.filePath,
      },
    })),
  };
  writeFileSync(JSON_OUT, `${JSON.stringify(jsonPayload, null, 2)}\n`);
  console.log(
    `[lifeops-action-collisions] wrote ${relative(REPO_ROOT, MD_OUT)} and ${relative(REPO_ROOT, JSON_OUT)}`,
  );
  console.log(
    `[lifeops-action-collisions] population=${rows.length} pairs>=${COLLISION_THRESHOLD}=${pairs.length}`,
  );
}

main();
