#!/usr/bin/env bun

/**
 * prompt-diff — Compare two versions of a prompt template.
 *
 * Renders both with the same context and shows metadata changes,
 * per-section token deltas, and a unified text diff.
 *
 * Usage:
 *   bun scripts/prompt-diff.ts --old prompts/trading/npc-market-decisions.ts \
 *       [--new prompts/feed/ambient-posts.ts] \
 *       [--context vars.json] [--vars key=val,key2=val2] \
 *       [--section-only] [--full]
 *
 * The --old flag also accepts git refs:  git:HEAD~1:packages/engine/src/prompts/trading/npc-market-decisions.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { structuredPatch } from "diff";

// ── ANSI helpers ──────────────────────────────────────────────────────────
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ── CLI arg parsing ───────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    context: { type: "string" },
    vars: { type: "string" },
    "section-only": { type: "boolean", default: false },
    full: { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.old) {
  console.error(
    `${RED}Error: --old <path|git:ref:path> is required${RESET}\n` +
      "Usage: bun scripts/prompt-diff.ts --old <path> [--new <path>] [--context <json>] [--vars k=v,...] [--section-only] [--full]",
  );
  process.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────
interface PromptMeta {
  id: string;
  version: string;
  temperature?: number;
  maxTokens?: number;
  template: string;
  label: string;
}

interface Section {
  heading: string;
  body: string;
  tokens: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function deltaStr(d: number): string {
  if (d > 0) return `${GREEN}+${fmt(d)}${RESET}`;
  if (d < 0) return `${RED}${fmt(d)}${RESET}`;
  return `${DIM}0${RESET}`;
}

/** Split rendered prompt into sections by common delimiters (=== / ## / ---). */
function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeading = "(preamble)";
  let currentLines: string[] = [];

  const flush = () => {
    const body = currentLines.join("\n");
    sections.push({
      heading: currentHeading,
      body,
      tokens: estimateTokens(body),
    });
  };

  for (const line of lines) {
    const m = line.match(/^(?:={3,}\s*(.+?)\s*={0,}|##\s+(.+)|---+\s*(.+))$/);
    if (m) {
      flush();
      currentHeading = (m[1] ?? m[2] ?? m[3] ?? line).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Render a template by replacing {{var}} with provided values.
 * Unresolved variables are preserved as-is to match the engine's
 * renderTemplate semantics and keep placeholder renames visible in diffs.
 */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return rendered;
}

/** Parse a git: specifier and return file content via `git show`. */
async function loadFromGit(spec: string): Promise<string> {
  // spec format: git:<ref>:<path>
  const firstColon = spec.indexOf(":");
  const secondColon = spec.indexOf(":", firstColon + 1);
  if (secondColon === -1) {
    throw new Error(`Invalid git spec "${spec}". Expected git:<ref>:<path>`);
  }
  const ref = spec.slice(firstColon + 1, secondColon);
  const filePath = spec.slice(secondColon + 1);
  const proc = Bun.spawn(["git", "show", `${ref}:${filePath}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git show ${ref}:${filePath} failed: ${err.trim()}`);
  }
  return new Response(proc.stdout).text();
}

/** Dynamically import a prompt module and find the PromptDefinition export. */
async function importPromptModule(filePath: string): Promise<PromptMeta> {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  const mod = await import(abs);
  // Find the first export that looks like a PromptDefinition
  for (const exp of Object.values(mod)) {
    const v = exp as Record<string, unknown>;
    if (v && typeof v === "object" && "template" in v && "id" in v) {
      return {
        id: v.id as string,
        version: v.version as string,
        temperature: v.temperature as number | undefined,
        maxTokens: v.maxTokens as number | undefined,
        template: v.template as string,
        label: filePath,
      };
    }
  }
  throw new Error(`No PromptDefinition export found in ${filePath}`);
}

/** Load a prompt from a git ref by writing to a temp file. */
async function loadPromptFromGit(spec: string): Promise<PromptMeta> {
  const content = await loadFromGit(spec);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-diff-"));
  const tmpFile = path.join(tmpDir, "prompt.ts");

  // Rewrite relative imports to absolute paths based on the original file location.
  // The git spec tells us where the file lived in the repo, so we resolve
  // each relative import from that directory.
  const repoRoot = path.resolve(import.meta.dir, "..");
  const firstColon = spec.indexOf(":");
  const secondColon = spec.indexOf(":", firstColon + 1);
  const originalPath = spec.slice(secondColon + 1);
  const originalDir = path.join(repoRoot, path.dirname(originalPath));

  const rewritten = content.replace(
    /from\s+['"](\.[^'"]+)['"]/g,
    (_match, relImport: string) => {
      const resolved = path.resolve(originalDir, relImport);
      return `from '${resolved}'`;
    },
  );

  fs.writeFileSync(tmpFile, rewritten);
  try {
    const meta = await importPromptModule(tmpFile);
    meta.label = spec;
    return meta;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function loadPrompt(ref: string): Promise<PromptMeta> {
  if (ref.startsWith("git:")) {
    return loadPromptFromGit(ref);
  }
  return importPromptModule(ref);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // 1. Load context variables
  const contextVars: Record<string, string> = {};
  if (values.context) {
    const raw = fs.readFileSync(path.resolve(values.context), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      contextVars[k] = String(v ?? "");
    }
  }
  if (values.vars) {
    for (const pair of values.vars.split(",")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      contextVars[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  // 2. Load prompts
  const oldPrompt = await loadPrompt(values.old!);
  const newRef = values.new ?? values.old!;
  const newPrompt =
    newRef === values.old ? oldPrompt : await loadPrompt(newRef);

  if (oldPrompt === newPrompt && !values.new) {
    console.log(
      `${YELLOW}Hint: --old and --new resolve to the same file. Use git: refs to compare versions.${RESET}`,
    );
  }

  // 3. Render
  const oldRendered = renderTemplate(oldPrompt.template, contextVars);
  const newRendered = renderTemplate(newPrompt.template, contextVars);

  // 4. Sections
  const oldSections = splitSections(oldRendered);
  const newSections = splitSections(newRendered);

  // Build heading → section maps
  const oldMap = new Map(oldSections.map((s) => [s.heading, s]));
  const newMap = new Map(newSections.map((s) => [s.heading, s]));
  const allHeadings = [
    ...new Set([
      ...oldSections.map((s) => s.heading),
      ...newSections.map((s) => s.heading),
    ]),
  ];

  // 5. Output
  console.log(`\n${BOLD}=== PROMPT DIFF ===${RESET}`);
  console.log(`Old: ${CYAN}${oldPrompt.label}${RESET}`);
  console.log(`New: ${CYAN}${newPrompt.label}${RESET}`);

  // Metadata
  console.log(`\n${BOLD}Metadata:${RESET}`);
  const tempOld = oldPrompt.temperature ?? "default";
  const tempNew = newPrompt.temperature ?? "default";
  const tempChanged = tempOld !== tempNew;
  console.log(
    `  Temperature: ${tempOld} → ${tempNew}${tempChanged ? ` ${YELLOW}<- CHANGED${RESET}` : ` ${DIM}(unchanged)${RESET}`}`,
  );

  const tokOld = oldPrompt.maxTokens ?? "default";
  const tokNew = newPrompt.maxTokens ?? "default";
  const tokChanged = tokOld !== tokNew;
  console.log(
    `  Max Tokens:  ${tokOld} → ${tokNew}${tokChanged ? ` ${YELLOW}<- CHANGED${RESET}` : ` ${DIM}(unchanged)${RESET}`}`,
  );

  // Section token comparison
  console.log(`\n${BOLD}Section Token Comparison:${RESET}`);
  const colW = 30;
  const numW = 8;
  console.log(
    `  ${"Section".padEnd(colW)} ${"Old".padStart(numW)} ${"New".padStart(numW)} ${"Delta".padStart(numW + 6)}`,
  );
  console.log(`  ${"─".repeat(colW + numW * 2 + numW + 8)}`);

  let totalOld = 0;
  let totalNew = 0;

  for (const heading of allHeadings) {
    const os = oldMap.get(heading);
    const ns = newMap.get(heading);
    const oTok = os?.tokens ?? 0;
    const nTok = ns?.tokens ?? 0;
    totalOld += oTok;
    totalNew += nTok;
    const d = nTok - oTok;

    let suffix = "";
    if (!os) suffix = `  ${GREEN}<- ADDED${RESET}`;
    else if (!ns) suffix = `  ${RED}<- REMOVED${RESET}`;
    else if (d !== 0) suffix = `  ${YELLOW}<- CHANGED${RESET}`;
    else if (oTok === 0 && nTok === 0) suffix = `  ${DIM}(no context)${RESET}`;

    const label =
      heading.length > colW - 2 ? `${heading.slice(0, colW - 5)}...` : heading;
    console.log(
      `  ${label.padEnd(colW)} ${fmt(oTok).padStart(numW)} ${fmt(nTok).padStart(numW)} ${deltaStr(d).padStart(numW + 6 + 10)}${suffix}`,
    );
  }

  console.log(`  ${"─".repeat(colW + numW * 2 + numW + 8)}`);
  const totalDelta = totalNew - totalOld;
  console.log(
    `  ${"TOTAL".padEnd(colW)} ${fmt(totalOld).padStart(numW)} ${fmt(totalNew).padStart(numW)} ${deltaStr(totalDelta).padStart(numW + 6 + 10)}`,
  );

  // Text diff
  if (!values["section-only"]) {
    console.log(`\n${BOLD}Text Diff:${RESET}`);

    const patch = structuredPatch(
      oldPrompt.label,
      newPrompt.label,
      oldRendered,
      newRendered,
      "",
      "",
      { context: 3 },
    );

    if (patch.hunks.length === 0) {
      console.log(`  ${DIM}(no text differences)${RESET}`);
    } else {
      const limit = values.full ? Number.POSITIVE_INFINITY : 100;
      let lineCount = 0;
      let truncated = false;

      for (const hunk of patch.hunks) {
        if (lineCount >= limit) {
          truncated = true;
          break;
        }
        console.log(
          `  ${CYAN}@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${RESET}`,
        );
        lineCount++;

        for (const line of hunk.lines) {
          if (lineCount >= limit) {
            truncated = true;
            break;
          }
          if (line.startsWith("+")) {
            console.log(`  ${GREEN}${line}${RESET}`);
          } else if (line.startsWith("-")) {
            console.log(`  ${RED}${line}${RESET}`);
          } else {
            console.log(`  ${DIM}${line}${RESET}`);
          }
          lineCount++;
        }
      }

      if (truncated) {
        console.log(
          `\n  ${YELLOW}... truncated at ${limit} lines. Use --full to see all.${RESET}`,
        );
      }
    }
  }

  console.log("");
}

main().catch((err: Error) => {
  console.error(`${RED}Error: ${err.message}${RESET}`);
  process.exit(1);
});
