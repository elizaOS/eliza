#!/usr/bin/env node
/**
 * lifeops-prompt-review.
 *
 * Reads the manifest produced by `scripts/lifeops-prompt-inventory.mjs` and
 * the latest trajectories under `~/.eliza/trajectories/` and emits one
 * Markdown page per prompt under
 * `docs/audits/lifeops-2026-05-11/prompts/<sanitized-id>.md`, plus an
 * `INDEX.md` linking all pages by token count and last-optimization score.
 *
 * The usage stats are derived from a best-effort scan of the trajectory
 * stages — we look for prompt text appearing in any stage's model input and
 * tally invocations + success rate from the surrounding tool/evaluation
 * stages. Stats are intentionally rough; they are review aids, not training
 * signal. When the trajectory store is empty (typical pre-run state), the
 * usage block reads "no trajectories on disk" and the page is still
 * generated so the operator can review the static prompt content alone.
 *
 * NO HTML output. Markdown only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "..", "..");
const AUDIT_DIR = join(REPO_ROOT, "docs", "audits", "lifeops-2026-05-11");
const MANIFEST_PATH = join(AUDIT_DIR, "prompts-manifest.json");
const PAGES_DIR = join(AUDIT_DIR, "prompts");

const TRAJECTORIES_ROOT =
  process.env.LIFEOPS_TRAJECTORIES_DIR ??
  join(process.env.HOME ?? "/Users/shawwalters", ".eliza", "trajectories");
const MAX_TRAJECTORIES = Number(process.env.LIFEOPS_REVIEW_MAX_TRAJ ?? "200");
const MAX_FAILURE_SAMPLES = 3;

// ---- Sanitize a prompt id into a filesystem-safe slug ---------------------

function slugify(id) {
  return id
    .replace(/[\\/]/g, "__")
    .replace(/[^a-zA-Z0-9._@-]+/g, "_")
    .slice(0, 180);
}

// ---- Manifest -------------------------------------------------------------

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `manifest not found at ${MANIFEST_PATH}. Run \`bun run lifeops:prompts:inventory\` first.`,
    );
  }
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (raw.schemaVersion !== "lifeops-prompt-inventory-v1") {
    throw new Error(`manifest schema mismatch: ${raw.schemaVersion}`);
  }
  return raw;
}

// ---- Trajectory ingest ---------------------------------------------------

function loadTrajectories() {
  if (!existsSync(TRAJECTORIES_ROOT)) {
    return { trajectories: [], scanned: 0 };
  }
  const trajectories = [];
  let scanned = 0;
  const agents = readdirSafe(TRAJECTORIES_ROOT);
  for (const agent of agents) {
    const agentDir = join(TRAJECTORIES_ROOT, agent);
    let st;
    try {
      st = statSync(agentDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const files = readdirSafe(agentDir).filter((f) => f.endsWith(".json"));
    // Read mtimes so we can take the latest N.
    const withMtime = files
      .map((f) => {
        const p = join(agentDir, f);
        let s;
        try {
          s = statSync(p);
        } catch {
          return null;
        }
        return { path: p, mtimeMs: s.mtimeMs };
      })
      .filter(Boolean);
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of withMtime) {
      if (trajectories.length >= MAX_TRAJECTORIES) break;
      scanned++;
      try {
        const parsed = JSON.parse(readFileSync(entry.path, "utf8"));
        trajectories.push({ path: entry.path, data: parsed });
      } catch {
        // skip malformed trajectory
      }
    }
    if (trajectories.length >= MAX_TRAJECTORIES) break;
  }
  return { trajectories, scanned };
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Flatten every stage's textual prompt(s) so we can match prompts that were
// actually in-context this turn. The recorded format puts the prompt in
// `stage.model.messages[].content` as strings. For tool stages we expose
// success + duration + the action name. The fingerprint for matching is the
// first 80 chars of the prompt's `text` field after trim() — long enough to
// be specific, short enough to survive templating substitutions like
// `{{contextObject}}` vs the rendered context block.
function fingerprintForPrompt(text) {
  return text.trim().replace(/\s+/g, " ").slice(0, 80);
}

function indexTrajectoryStages(trajectories) {
  // List of { traj, stage, kind, messagesText, succeeded }
  const stages = [];
  for (const t of trajectories) {
    const traj = t.data;
    if (!Array.isArray(traj.stages)) continue;
    let turnSucceeded = traj.status === "finished";
    for (const stage of traj.stages) {
      const kind = stage.kind ?? null;
      const messagesText = collectStageText(stage);
      stages.push({
        traj,
        stage,
        kind,
        messagesText,
        succeeded: turnSucceeded,
      });
    }
  }
  return stages;
}

function collectStageText(stage) {
  const buf = [];
  const messages = stage?.model?.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (typeof msg.content === "string") buf.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            buf.push(part.text);
          }
        }
      }
    }
  }
  if (typeof stage?.input === "string") buf.push(stage.input);
  if (typeof stage?.prompt === "string") buf.push(stage.prompt);
  return buf.join("\n");
}

// Compute per-prompt usage stats by scanning stages for the prompt's
// fingerprint string.
function computeUsageStats(prompt, stages) {
  const fp = fingerprintForPrompt(prompt.text);
  if (!fp || fp.length < 16) {
    return {
      invocations: 0,
      successRate: null,
      avgInputChars: null,
      sampleFailures: [],
    };
  }
  let inv = 0;
  let succ = 0;
  let inputCharSum = 0;
  const failures = [];
  for (const s of stages) {
    if (!s.messagesText) continue;
    if (!s.messagesText.includes(fp)) continue;
    inv++;
    if (s.succeeded) succ++;
    inputCharSum += s.messagesText.length;
    if (!s.succeeded && failures.length < MAX_FAILURE_SAMPLES) {
      const userMatch = s.traj.rootMessage?.text;
      failures.push({
        trajectoryId: s.traj.trajectoryId,
        scenarioId: s.traj.scenarioId ?? null,
        status: s.traj.status,
        userText: userMatch ?? null,
        stageKind: s.kind,
      });
    }
  }
  return {
    invocations: inv,
    successRate: inv > 0 ? succ / inv : null,
    avgInputChars: inv > 0 ? Math.round(inputCharSum / inv) : null,
    sampleFailures: failures,
  };
}

// ---- Suggested-edits heuristics ------------------------------------------
//
// These are mechanical, low-confidence rewrites that the human reviewer can
// accept or discard. We never apply them — they only land in the review
// page so the operator has a quick concrete starting point.
function suggestEdits(prompt) {
  const suggestions = [];
  const text = prompt.text;
  if (typeof text !== "string") return suggestions;

  // 1) very long; suggest the compressed variant if one exists.
  if (prompt.compressedText && text.length > 200) {
    const ratio = (
      (1 - prompt.compressedText.length / text.length) *
      100
    ).toFixed(0);
    suggestions.push(
      `Compressed variant exists (${prompt.compressedText.length} chars vs ${text.length} chars — ${ratio}% shorter). Consider promoting it when planner cache pressure is high.`,
    );
  }

  // 2) duplicate phrases (5+ word sequences repeated within the same text).
  const dup = findDuplicateNGrams(text, 5);
  if (dup) {
    suggestions.push(
      `Repeated phrase: \`${dup}\` — appears more than once; consider deduping for token savings.`,
    );
  }

  // 3) very wordy connectives.
  const wordy = [
    [/\bplease\s+/gi, "drop hedges like 'please'"],
    [/\bmake sure (to|that)\b/gi, "shorten 'make sure to/that' → 'ensure'"],
    [/\bin order to\b/gi, "'in order to' → 'to'"],
    [/\bas well as\b/gi, "'as well as' → 'and'"],
    [/\bnote that\b/gi, "drop 'note that' filler"],
  ];
  const hits = new Set();
  for (const [re, hint] of wordy) {
    if (re.test(text)) hits.add(hint);
  }
  for (const h of hits) suggestions.push(h);

  // 4) compressed variant absent — only complain for action descriptions
  // and parameter descriptions over 100 chars.
  if (
    !prompt.compressedText &&
    (prompt.kind === "action-description" ||
      prompt.kind === "action-parameter") &&
    text.length > 100
  ) {
    suggestions.push(
      `No compressed variant. Authors should add \`descriptionCompressed\` — the planner caches both shapes and falls back to the long form when the compressed one is absent.`,
    );
  }

  return suggestions;
}

function findDuplicateNGrams(text, n) {
  const tokens = text
    .toLowerCase()
    .replace(/[\n\r]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < n * 2) return null;
  const seen = new Map();
  for (let i = 0; i + n <= tokens.length; i++) {
    const phrase = tokens.slice(i, i + n).join(" ");
    if (phrase.length < 20) continue;
    const count = (seen.get(phrase) ?? 0) + 1;
    seen.set(phrase, count);
    if (count >= 2) return phrase;
  }
  return null;
}

// ---- Markdown rendering ---------------------------------------------------

function renderPromptPage(prompt, stats) {
  const lines = [];
  lines.push(`# \`${prompt.id}\``);
  lines.push("");
  lines.push(`- **Kind**: ${prompt.kind}`);
  if (prompt.task) lines.push(`- **Task**: ${prompt.task}`);
  lines.push(`- **Owner**: ${prompt.owner}`);
  lines.push(
    `- **File**: \`${prompt.filePath}${prompt.fileLine ? `:${prompt.fileLine}` : ""}\``,
  );
  lines.push(`- **Token count**: ${prompt.tokenCount}`);
  if (prompt.lastOptimizedAt) {
    const score =
      typeof prompt.lastOptimizerScore === "number"
        ? prompt.lastOptimizerScore.toFixed(3)
        : "n/a";
    lines.push(
      `- **Last optimized**: ${prompt.lastOptimizedAt} (score ${score})`,
    );
  } else {
    lines.push(`- **Last optimized**: never`);
  }
  if (prompt.extras?.actionName) {
    lines.push(`- **Action**: ${prompt.extras.actionName}`);
  }
  if (prompt.extras?.parameterName) {
    lines.push(
      `- **Parameter**: ${prompt.extras.parameterName} (required: ${prompt.extras.required ? "yes" : "no"})`,
    );
  }
  if (Array.isArray(prompt.extras?.similes) && prompt.extras.similes.length > 0) {
    lines.push(`- **Similes**: ${prompt.extras.similes.join(", ")}`);
  }
  lines.push("");

  lines.push("## Current text");
  lines.push("```");
  lines.push(prompt.text);
  lines.push("```");
  lines.push("");

  lines.push("## Compressed variant");
  lines.push("```");
  lines.push(prompt.compressedText ?? "none");
  lines.push("```");
  lines.push("");

  lines.push("## Usage stats (latest trajectories)");
  if (stats.invocations === 0) {
    lines.push("- Invocations: 0 (this prompt was not matched in any recent trajectory)");
  } else {
    lines.push(`- Invocations: ${stats.invocations}`);
    lines.push(
      `- Success rate: ${stats.successRate === null ? "n/a" : stats.successRate.toFixed(2)}`,
    );
    lines.push(
      `- Avg input chars when matched: ${stats.avgInputChars ?? "n/a"}`,
    );
  }
  lines.push("");

  lines.push("## Sample failure transcripts");
  if (stats.sampleFailures.length === 0) {
    lines.push("None.");
  } else {
    for (const f of stats.sampleFailures) {
      lines.push(
        `- traj \`${f.trajectoryId}\` scenario \`${f.scenarioId ?? "unknown"}\` status=${f.status} stage=${f.stageKind ?? "?"}`,
      );
      if (f.userText) {
        const trimmed =
          f.userText.length > 200 ? `${f.userText.slice(0, 200)}…` : f.userText;
        lines.push(`  - user: \`${trimmed}\``);
      }
    }
  }
  lines.push("");

  const suggestions = suggestEdits(prompt);
  lines.push("## Suggested edits (heuristic)");
  if (suggestions.length === 0) {
    lines.push("None.");
  } else {
    for (const s of suggestions) lines.push(`- ${s}`);
  }
  lines.push("");

  lines.push("## Actions");
  lines.push(
    "- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`",
  );
  lines.push(
    "- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`",
  );
  lines.push("");

  return lines.join("\n");
}

function renderIndex(rows) {
  const lines = [];
  lines.push("# LifeOps prompt review — index");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Every prompt below has its own Markdown review page. Sorted by token count descending so the heaviest prompts surface first.",
  );
  lines.push("");
  lines.push("| Kind | Id | Tokens | Last optimized | Score |");
  lines.push("|---|---|---:|---|---:|");
  const sorted = [...rows].sort((a, b) => b.tokenCount - a.tokenCount);
  for (const r of sorted) {
    const score =
      typeof r.lastOptimizerScore === "number"
        ? r.lastOptimizerScore.toFixed(3)
        : "—";
    const opt = r.lastOptimizedAt ?? "—";
    lines.push(
      `| ${r.kind} | [\`${escapeMd(r.id)}\`](${encodeURI(r.slug)}.md) | ${r.tokenCount} | ${opt} | ${score} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function escapeMd(s) {
  return s.replace(/\|/g, "\\|");
}

// ---- Main -----------------------------------------------------------------

function main() {
  const manifest = loadManifest();
  // Remove stale pages from previous runs so renamed slugs don't leave
  // dangling .md files. We rebuild the directory from scratch each run.
  if (existsSync(PAGES_DIR)) rmSync(PAGES_DIR, { recursive: true, force: true });
  mkdirSync(PAGES_DIR, { recursive: true });
  const { trajectories, scanned } = loadTrajectories();
  console.log(
    `[lifeops-prompt-review] loaded ${trajectories.length} trajectories (scanned ${scanned})`,
  );
  const stages = indexTrajectoryStages(trajectories);

  const indexRows = [];
  for (const prompt of manifest.prompts) {
    const stats = computeUsageStats(prompt, stages);
    const slug = slugify(prompt.id);
    const out = join(PAGES_DIR, `${slug}.md`);
    writeFileSync(out, renderPromptPage(prompt, stats));
    indexRows.push({
      id: prompt.id,
      slug,
      kind: prompt.kind,
      tokenCount: prompt.tokenCount,
      lastOptimizedAt: prompt.lastOptimizedAt ?? null,
      lastOptimizerScore: prompt.lastOptimizerScore ?? null,
    });
  }
  writeFileSync(join(PAGES_DIR, "INDEX.md"), renderIndex(indexRows));
  console.log(
    `[lifeops-prompt-review] wrote ${indexRows.length} pages to ${relative(REPO_ROOT, PAGES_DIR)}/`,
  );
}

main();
