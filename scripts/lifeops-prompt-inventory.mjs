#!/usr/bin/env node
/**
 * lifeops-prompt-inventory.
 *
 * Walks the repo and emits a single JSON manifest covering every "prompt"
 * surface the planner / runtime can exercise:
 *
 *  - the planner template + JSON schema (`packages/core/src/prompts/planner.ts`)
 *  - all named templates in `packages/prompts/src/index.ts`
 *  - the 5 OptimizedPromptService task baselines (the baseline strings
 *    actually fed into `resolveOptimizedPromptForRuntime(...)`)
 *  - every action `description` + `descriptionCompressed`
 *  - every action `routingHint`
 *  - every action parameter `description` + `descriptionCompressed`
 *
 * Plus, for each entry, the latest optimizer artifact metadata under
 * `~/.eliza/optimized-prompts/<task>/current` (or `~/.eliza/...` as a
 * fallback) when one exists.
 *
 * Action coverage strategy: we walk the source tree under `plugins/*` and
 * `packages/{core,agent}/src` for `*.ts` files in `actions/` directories or
 * named `*action.ts`, then extract every `name: "FOO_BAR"` declaration that
 * sits in a block containing `handler:` or `validate:` — that pattern matches
 * the canonical Action object shape regardless of whether the file uses
 * `satisfies Action`, `: Action`, `factoryFn({...})`, or no type annotation
 * at all. Helper-only / sub-action handlers are included; the umbrella
 * routing-vs-subaction distinction is recorded in `extras` instead of being
 * pruned. The generated action specs
 * (`packages/prompts/specs/actions/*.json`) are layered on top so registered
 * umbrella actions that source their description from a JSON spec via
 * `requireActionSpec(...)` still get their full description text in the
 * manifest.
 *
 * Output: docs/audits/lifeops-2026-05-11/prompts-manifest.json
 *
 * NO HTML emitted. Markdown + JSON only. This script is review-only and
 * never modifies prompt strings.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "..", "..");
const SCHEMA_VERSION = "lifeops-prompt-inventory-v1";
const OUT_DIR = join(REPO_ROOT, "docs", "audits", "lifeops-2026-05-11");
const OUT_PATH = join(OUT_DIR, "prompts-manifest.json");

// ---- Token estimate -------------------------------------------------------
// No tiktoken dependency. Use the common 1 token ≈ 4 chars / 0.75 words
// approximation. Take the larger of the char-based and word-based estimates
// so punctuation/code-heavy strings are not undercounted.
function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const byChar = Math.ceil(text.length / 4);
  const byWord = Math.ceil(text.trim().split(/\s+/).length * 1.3);
  return Math.max(byChar, byWord);
}

// ---- Optimizer artifact lookup -------------------------------------------
// OptimizedPromptService writes per-task artifacts under one of:
//   ~/.eliza/optimized-prompts/<task>/current   (symlink to vN.json)
//   ~/.eliza/optimized-prompts/<task>/current
// If neither exists fall back to scanning the directory for the
// `generatedAt`-newest `vN.json`. Returns null when nothing is on disk.
function findOptimizerArtifact(task) {
  const homedir =
    process.env.HOME ?? process.env.USERPROFILE ?? "/Users/shawwalters";
  const candidates = [
    join(homedir, ".eliza", "optimized-prompts", task),
    join(homedir, ".eliza", "optimized-prompts", task),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const current = join(dir, "current");
    if (existsSync(current)) {
      try {
        const raw = readFileSync(current, "utf8");
        const parsed = JSON.parse(raw);
        return { path: current, parsed };
      } catch {
        // fallthrough to directory scan
      }
    }
    let newest = null;
    let newestTime = 0;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const file of entries) {
      if (!/^v\d+\.json$/.test(file)) continue;
      const full = join(dir, file);
      try {
        const raw = readFileSync(full, "utf8");
        const parsed = JSON.parse(raw);
        const t = Date.parse(parsed?.generatedAt ?? "") || 0;
        if (t >= newestTime) {
          newest = { path: full, parsed };
          newestTime = t;
        }
      } catch {
        // skip
      }
    }
    if (newest) return newest;
  }
  return null;
}

// ---- Source utilities -----------------------------------------------------

function readSource(absPath) {
  return readFileSync(absPath, "utf8");
}

function repoRelative(absPath) {
  return relative(REPO_ROOT, absPath);
}

function lineOfIndex(src, index) {
  return src.slice(0, index).split("\n").length;
}

// Match a key followed by a single string literal in any of the three quote
// styles. Returns { value, index } where `index` points at the start of the
// key. The matcher anchors at a leading newline or `{` to avoid catching
// keys deep inside example arrays. The `allowConcat` form additionally
// supports JS string concatenation: `"foo" +\n "bar"`.
function extractStringField(block, fieldName, { allowConcat = true } = {}) {
  const single = block.match(
    new RegExp(
      `(?:^|[\\n,{])\\s*${fieldName}\\s*:\\s*([\\\`"'])([\\s\\S]*?)\\1`,
    ),
  );
  if (!single) return null;
  let value = single[2];
  let endIdx = single.index + single[0].length;
  if (allowConcat) {
    // Look for "+ '...'" trailing concatenations.
    while (true) {
      const tail = block.slice(endIdx).match(/^\s*\+\s*([`"'])([\s\S]*?)\1/);
      if (!tail) break;
      value += tail[2];
      endIdx += tail[0].length;
    }
  }
  return { value, index: single.index };
}

// Extract `export const <name> = \`...\``-style template literals from the
// given source. Returns { name, text, lineNumber }.
function extractBacktickConsts(source) {
  const out = [];
  const pattern =
    /export\s+const\s+([a-zA-Z_$][\w$]*)\s*=\s*`([\s\S]*?)`;\s*$/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, name, text] = match;
    const line = lineOfIndex(source, match.index);
    if (/^[A-Z][A-Z_0-9]*$/.test(name)) continue;
    out.push({ name, text, lineNumber: line });
  }
  return out;
}

function extractPlannerTemplate() {
  const path = join(
    REPO_ROOT,
    "packages",
    "core",
    "src",
    "prompts",
    "planner.ts",
  );
  const src = readSource(path);
  const consts = extractBacktickConsts(src);
  const tmpl = consts.find((c) => c.name === "plannerTemplate");
  const schemaMatch = src.match(
    /export\s+const\s+plannerSchema\s*:\s*JSONSchema\s*=\s*(\{[\s\S]*?\n\});\s*$/m,
  );
  let schemaText = null;
  let schemaLine = null;
  if (schemaMatch) {
    schemaText = schemaMatch[1];
    schemaLine = lineOfIndex(src, schemaMatch.index);
  }
  return {
    template: tmpl
      ? {
          id: "planner.template.baseline",
          kind: "planner",
          task: "action_planner",
          owner: "packages/core",
          filePath: repoRelative(path),
          fileLine: tmpl.lineNumber,
          text: tmpl.text,
          tokenCount: estimateTokens(tmpl.text),
        }
      : null,
    schema: schemaText
      ? {
          id: "planner.schema.baseline",
          kind: "planner",
          task: "action_planner",
          owner: "packages/core",
          filePath: repoRelative(path),
          fileLine: schemaLine,
          text: schemaText,
          tokenCount: estimateTokens(schemaText),
          extras: { format: "jsonschema" },
        }
      : null,
  };
}

function extractPromptsPackageTemplates() {
  const path = join(REPO_ROOT, "packages", "prompts", "src", "index.ts");
  const src = readSource(path);
  const consts = extractBacktickConsts(src);
  return consts.map((c) => ({
    id: `prompts.${c.name}`,
    kind: "template",
    task: null,
    owner: "packages/prompts",
    filePath: repoRelative(path),
    fileLine: c.lineNumber,
    text: c.text,
    tokenCount: estimateTokens(c.text),
  }));
}

function extractServiceTaskBaselines(allTemplates, plannerTemplate) {
  const out = [];
  const messagePath = join(
    REPO_ROOT,
    "packages",
    "core",
    "src",
    "services",
    "message.ts",
  );
  const messageSrc = readSource(messagePath);

  if (plannerTemplate) {
    const artifact = findOptimizerArtifact("action_planner");
    out.push({
      id: "service-task.action_planner",
      kind: "service-task",
      task: "action_planner",
      owner: "packages/core",
      filePath: plannerTemplate.filePath,
      fileLine: plannerTemplate.fileLine,
      text: plannerTemplate.text,
      tokenCount: plannerTemplate.tokenCount,
      lastOptimizedAt: artifact?.parsed?.generatedAt ?? null,
      lastOptimizerArtifact: artifact?.path ?? null,
      lastOptimizerScore: artifact?.parsed?.score ?? null,
      extras: artifact
        ? {
            optimizer: artifact.parsed?.optimizer ?? null,
            baselineScore: artifact.parsed?.baselineScore ?? null,
            datasetSize: artifact.parsed?.datasetSize ?? null,
          }
        : undefined,
    });
  }

  const messageHandlerTemplate = allTemplates.find(
    (t) => t.id === "prompts.messageHandlerTemplate",
  );
  for (const task of ["should_respond", "context_routing"]) {
    const artifact = findOptimizerArtifact(task);
    if (!messageHandlerTemplate) continue;
    out.push({
      id: `service-task.${task}`,
      kind: "service-task",
      task,
      owner: "packages/core",
      filePath: messageHandlerTemplate.filePath,
      fileLine: messageHandlerTemplate.fileLine,
      text: messageHandlerTemplate.text,
      tokenCount: messageHandlerTemplate.tokenCount,
      lastOptimizedAt: artifact?.parsed?.generatedAt ?? null,
      lastOptimizerArtifact: artifact?.path ?? null,
      lastOptimizerScore: artifact?.parsed?.score ?? null,
      extras: {
        baselineSource: "packages/prompts/src/index.ts:messageHandlerTemplate",
        consumedBy:
          "packages/core/src/services/message.ts:renderMessageHandlerInstructions",
        ...(artifact
          ? {
              optimizer: artifact.parsed?.optimizer ?? null,
              baselineScore: artifact.parsed?.baselineScore ?? null,
            }
          : {}),
      },
    });
  }

  // RESPONSE baseline = RESPONSE_TASK_BASELINE_INSTRUCTIONS string-array in message.ts.
  const responseMatch = messageSrc.match(
    /const\s+RESPONSE_TASK_BASELINE_INSTRUCTIONS\s*=\s*\[([\s\S]*?)\]\.join\(["']\\n["']\);/,
  );
  if (responseMatch) {
    const arrLines = responseMatch[1]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/,$/, "").trim());
    const stringLines = [];
    for (const raw of arrLines) {
      const m = raw.match(/^["'`](.*)["'`]$/);
      if (m) stringLines.push(m[1]);
    }
    const text = stringLines.join("\n");
    const lineNumber = lineOfIndex(messageSrc, responseMatch.index);
    const artifact = findOptimizerArtifact("response");
    out.push({
      id: "service-task.response",
      kind: "service-task",
      task: "response",
      owner: "packages/core",
      filePath: repoRelative(messagePath),
      fileLine: lineNumber,
      text,
      tokenCount: estimateTokens(text),
      lastOptimizedAt: artifact?.parsed?.generatedAt ?? null,
      lastOptimizerArtifact: artifact?.path ?? null,
      lastOptimizerScore: artifact?.parsed?.score ?? null,
      extras: {
        consumedBy:
          "packages/core/src/services/message.ts:generateDirectReplyOnce",
        ...(artifact ? { optimizer: artifact.parsed?.optimizer ?? null } : {}),
      },
    });
  }

  const imageDescTemplate = allTemplates.find(
    (t) => t.id === "prompts.imageDescriptionTemplate",
  );
  if (imageDescTemplate) {
    const artifact = findOptimizerArtifact("media_description");
    out.push({
      id: "service-task.media_description",
      kind: "service-task",
      task: "media_description",
      owner: "packages/core",
      filePath: imageDescTemplate.filePath,
      fileLine: imageDescTemplate.fileLine,
      text: imageDescTemplate.text,
      tokenCount: imageDescTemplate.tokenCount,
      lastOptimizedAt: artifact?.parsed?.generatedAt ?? null,
      lastOptimizerArtifact: artifact?.path ?? null,
      lastOptimizerScore: artifact?.parsed?.score ?? null,
      extras: {
        baselineSource:
          "packages/prompts/src/index.ts:imageDescriptionTemplate",
        consumedBy: [
          "packages/core/src/features/basic-capabilities/index.ts",
          "packages/core/src/features/basic-capabilities/evaluators/attachment-image-analysis.ts",
        ],
      },
    });
  }
  return out;
}

// ---- Action inventory: source walker --------------------------------------

function collectActionSourceFiles() {
  const roots = [
    join(REPO_ROOT, "plugins"),
    join(REPO_ROOT, "packages", "agent", "src"),
    join(REPO_ROOT, "packages", "core", "src"),
  ];
  const matches = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, matches);
  }
  return matches;

  function walk(dir, acc) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(REPO_ROOT, full);
      if (rel.includes("/node_modules/") || rel.startsWith("node_modules/"))
        continue;
      if (rel.includes("/dist/")) continue;
      if (rel.includes("/__tests__/")) continue;
      if (rel.includes("/fixtures/")) continue;
      if (/\.test\.[tj]sx?$/.test(name)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, acc);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      if (!/actions\//.test(rel) && !/action\.tsx?$/.test(name)) continue;
      acc.push(full);
    }
  }
}

// Extract Action objects from source. We anchor on `name: "FOO_BAR"` literals
// and verify the surrounding block contains `handler:` or `validate:`. The
// "block" we read is up to 16 KB after the name match — large enough to
// capture multi-page action declarations with embedded examples but small
// enough that the next sibling action declaration starts a new block.
function extractActionsFromSource() {
  const files = collectActionSourceFiles();
  // Map keyed by `${name}@${filePath}` so duplicate names in different files
  // both appear. Action `name` is the planner-visible id; some helper
  // sub-actions reuse the parent's name (e.g. SKILL handlers) — we keep them
  // distinct in the manifest.
  const out = [];
  const seenSig = new Set();
  for (const file of files) {
    let src;
    try {
      src = readSource(file);
    } catch {
      continue;
    }
    const filePath = repoRelative(file);
    const nameRegex = /(?:^|[\n,{])\s*name\s*:\s*["'`]([A-Z][A-Z_0-9]+)["'`]/g;
    let m;
    while ((m = nameRegex.exec(src)) !== null) {
      const actionName = m[1];
      const matchIndex = m.index;
      const block = src.slice(matchIndex, matchIndex + 16000);
      const isAction =
        /\n\s+handler\s*:/.test(block) || /\n\s+validate\s*:/.test(block);
      if (!isAction) continue;
      const lineNumber = lineOfIndex(src, matchIndex);
      const sig = `${actionName}@${filePath}:${lineNumber}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);

      const descExtract = extractStringField(block, "description");
      const compExtract =
        extractStringField(block, "descriptionCompressed") ??
        extractStringField(block, "compressedDescription");
      const routingExtract = extractStringField(block, "routingHint");
      const similesMatch = block.match(/similes\s*:\s*\[([\s\S]*?)\]/);
      const similes = similesMatch
        ? Array.from(
            similesMatch[1].matchAll(/["'`]([A-Z][A-Z_0-9]*)["'`]/g),
          ).map((x) => x[1])
        : [];
      // Parameter extraction: look for `parameters: [` after the name match,
      // grab balanced braces (string-aware) and pull each `{ ... }` object's
      // `name:` + `description:` fields.
      const parameters = extractParametersBlock(block);

      out.push({
        actionName,
        filePath,
        fileLine: lineNumber,
        description: descExtract?.value ?? null,
        descriptionLine: descExtract
          ? lineOfIndex(src, matchIndex + descExtract.index)
          : null,
        descriptionCompressed: compExtract?.value ?? null,
        routingHint: routingExtract?.value ?? null,
        routingHintLine: routingExtract
          ? lineOfIndex(src, matchIndex + routingExtract.index)
          : null,
        similes,
        parameters,
      });
    }
  }
  return out;
}

// Pull a `parameters: [ { name: "...", description: "...", ... }, ... ]` array
// out of an action block. Returns [] when no parameters are declared. The
// extractor is string-aware: it tracks ` " ' and brace nesting so multi-line
// schemas inside a parameter don't terminate the array early.
function extractParametersBlock(block) {
  const start = block.search(/(?:^|[\n,{])\s*parameters\s*:\s*\[/);
  if (start === -1) return [];
  let i = block.indexOf("[", start);
  if (i === -1) return [];
  i++; // step past '['
  // Track nesting of [ ] and { } while skipping over string contents.
  let depth = 1;
  let inString = null;
  let escaped = false;
  const arrStart = i;
  for (; i < block.length && depth > 0; i++) {
    const ch = block[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  if (depth !== 0) return [];
  const arrContent = block.slice(arrStart, i - 1);
  // Split into top-level `{ ... }` chunks.
  const objects = splitTopLevelObjects(arrContent);
  const params = [];
  for (const obj of objects) {
    const nameField = extractStringField(obj, "name");
    if (!nameField) continue;
    const descField = extractStringField(obj, "description");
    const compField =
      extractStringField(obj, "descriptionCompressed") ??
      extractStringField(obj, "compressedDescription");
    const requiredMatch = obj.match(/required\s*:\s*(true|false)/);
    params.push({
      name: nameField.value,
      description: descField?.value ?? null,
      descriptionCompressed: compField?.value ?? null,
      required: requiredMatch ? requiredMatch[1] === "true" : false,
    });
  }
  return params;
}

function splitTopLevelObjects(content) {
  const out = [];
  let depth = 0;
  let inString = null;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

// ---- Spec catalog (umbrella actions sourced from generated specs) --------

function loadActionSpecs() {
  const coreSpecPath = join(
    REPO_ROOT,
    "packages",
    "prompts",
    "specs",
    "actions",
    "core.json",
  );
  const pluginSpecPath = join(
    REPO_ROOT,
    "packages",
    "prompts",
    "specs",
    "actions",
    "plugins.generated.json",
  );
  const coreSpec = JSON.parse(readSource(coreSpecPath));
  const pluginSpec = JSON.parse(readSource(pluginSpecPath));
  const map = new Map();
  for (const a of coreSpec.actions || []) {
    map.set(a.name, {
      spec: a,
      specOrigin: repoRelative(coreSpecPath),
      defaultOwner: "packages/core",
    });
  }
  for (const a of pluginSpec.actions || []) {
    map.set(a.name, {
      spec: a,
      specOrigin: repoRelative(pluginSpecPath),
      defaultOwner: null, // filled in from source walker
    });
  }
  return map;
}

function deriveOwnerFromFile(repoRelPath) {
  if (repoRelPath.startsWith("plugins/")) {
    const parts = repoRelPath.split("/");
    return `plugins/${parts[1]}`;
  }
  if (repoRelPath.startsWith("packages/")) {
    const parts = repoRelPath.split("/");
    return `packages/${parts[1]}`;
  }
  return repoRelPath;
}

// Merge spec + source declarations into Action records. When the source-side
// description is absent (umbrella actions that call `requireActionSpec(name)`
// at runtime instead of inlining the string) we substitute the spec text.
// When both are present, we trust the source string.
function buildActionEntries() {
  const sourceActions = extractActionsFromSource();
  const specMap = loadActionSpecs();
  const entries = [];

  // Track which spec names were consumed by source records so we can emit
  // spec-only rows for umbrella actions registered exclusively from a
  // factory.
  const consumedSpecs = new Set();

  for (const action of sourceActions) {
    const spec = specMap.get(action.actionName);
    if (spec) consumedSpecs.add(action.actionName);
    const owner = deriveOwnerFromFile(action.filePath);
    const description = action.description ?? spec?.spec?.description ?? null;
    const descriptionCompressed =
      action.descriptionCompressed ??
      spec?.spec?.descriptionCompressed ??
      spec?.spec?.compressedDescription ??
      null;
    const similes =
      action.similes.length > 0 ? action.similes : (spec?.spec?.similes ?? []);
    // Include the source line number when the same action name appears
    // multiple times in the same file (umbrella + parameter-inheritance
    // pattern in OWNER_ROUTINES, for example) so each row gets a unique id.
    const dupCount = sourceActions.filter(
      (a) =>
        a.actionName === action.actionName && a.filePath === action.filePath,
    ).length;
    const baseId =
      dupCount > 1
        ? `action.${action.actionName}@${action.filePath}:${action.fileLine}`
        : `action.${action.actionName}@${action.filePath}`;

    if (description) {
      entries.push({
        id: `${baseId}.description`,
        kind: "action-description",
        task: null,
        owner,
        filePath: action.filePath,
        fileLine: action.descriptionLine ?? action.fileLine,
        text: description,
        compressedText: descriptionCompressed,
        tokenCount: estimateTokens(description),
        extras: {
          actionName: action.actionName,
          similes,
          source: action.description ? "inline" : "spec-catalog",
        },
      });
    }

    if (action.routingHint) {
      entries.push({
        id: `${baseId}.routingHint`,
        kind: "routing-hint",
        task: null,
        owner,
        filePath: action.filePath,
        fileLine: action.routingHintLine ?? action.fileLine,
        text: action.routingHint,
        tokenCount: estimateTokens(action.routingHint),
        extras: { actionName: action.actionName },
      });
    }

    // Parameters: prefer source declarations, fall back to spec.
    const params =
      action.parameters.length > 0
        ? action.parameters
        : (spec?.spec?.parameters ?? []);
    for (const param of params) {
      if (!param.description) continue;
      entries.push({
        id: `${baseId}.param.${param.name}.description`,
        kind: "action-parameter",
        task: null,
        owner,
        filePath: action.filePath,
        fileLine: action.fileLine,
        text: param.description,
        compressedText:
          param.descriptionCompressed ?? param.compressedDescription ?? null,
        tokenCount: estimateTokens(param.description),
        extras: {
          actionName: action.actionName,
          parameterName: param.name,
          required: param.required ?? false,
        },
      });
    }
  }

  // Emit spec-only rows for any action whose source declaration we missed
  // (helps coverage parity with the runtime planner — e.g. factory-built
  // page-action-groups, which return Action objects without a literal
  // `name: "..."` field).
  for (const [name, { spec, specOrigin, defaultOwner }] of specMap.entries()) {
    if (consumedSpecs.has(name)) continue;
    const baseId = `action.${name}@${specOrigin}`;
    if (spec.description) {
      entries.push({
        id: `${baseId}.description`,
        kind: "action-description",
        task: null,
        owner: defaultOwner ?? "spec-only",
        filePath: specOrigin,
        fileLine: null,
        text: spec.description,
        compressedText:
          spec.descriptionCompressed ?? spec.compressedDescription ?? null,
        tokenCount: estimateTokens(spec.description),
        extras: {
          actionName: name,
          source: "spec-catalog",
          similes: spec.similes ?? [],
        },
      });
    }
    for (const param of spec.parameters ?? []) {
      if (!param.description) continue;
      entries.push({
        id: `${baseId}.param.${param.name}.description`,
        kind: "action-parameter",
        task: null,
        owner: defaultOwner ?? "spec-only",
        filePath: specOrigin,
        fileLine: null,
        text: param.description,
        compressedText:
          param.descriptionCompressed ?? param.compressedDescription ?? null,
        tokenCount: estimateTokens(param.description),
        extras: {
          actionName: name,
          parameterName: param.name,
          required: param.required ?? false,
          source: "spec-catalog",
        },
      });
    }
  }

  return entries;
}

// ---- Compose manifest -----------------------------------------------------

function buildManifest() {
  const { template, schema } = extractPlannerTemplate();
  const allTemplates = extractPromptsPackageTemplates();
  const serviceTasks = extractServiceTaskBaselines(allTemplates, template);
  const actionEntries = buildActionEntries();

  const prompts = [];
  if (template) prompts.push(template);
  if (schema) prompts.push(schema);
  for (const t of allTemplates) prompts.push(t);
  for (const s of serviceTasks) prompts.push(s);
  for (const a of actionEntries) prompts.push(a);

  // Distinct action-name count (separate from the row count, which includes
  // parameters and routing hints).
  const distinctActions = new Set();
  for (const e of actionEntries) {
    const name = e.extras?.actionName;
    if (name) distinctActions.add(name);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    counts: {
      total: prompts.length,
      byKind: countBy(prompts, (p) => p.kind),
      distinctActions: distinctActions.size,
    },
    prompts,
  };
}

function countBy(items, fn) {
  const out = {};
  for (const x of items) {
    const k = fn(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const manifest = buildManifest();
  writeFileSync(OUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[lifeops-prompt-inventory] wrote ${OUT_PATH}`);
  console.log(
    `[lifeops-prompt-inventory] prompts=${manifest.counts.total}  byKind=${JSON.stringify(manifest.counts.byKind)}  distinctActions=${manifest.counts.distinctActions}`,
  );
}

main();
