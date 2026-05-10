#!/usr/bin/env node
/**
 * `translate-action-examples` — bulk-translation harness for ActionExamples.
 *
 * Wires the existing `MultilingualPromptRegistry` (W2-E,
 * `plugins/app-lifeops/src/lifeops/i18n/prompt-registry.ts`) into a CLI flow
 * that:
 *   1. Loads a TypeScript action file as text and extracts its
 *      `examples: ActionExample[][]` array via static AST parsing (no module
 *      load — the action graph would drag the whole runtime in).
 *   2. For each English example pair, calls Cerebras `gpt-oss-120b` with a
 *      strict translation prompt that returns JSON of the same shape.
 *   3. Emits a TypeScript source fragment registering the translations onto
 *      the registry, keyed `<actionName>.<index>:<locale>`.
 *
 * The harness is the proof-of-concept path. The Phase-3 sample translations
 * land as a generated `i18n/generated/<action>.<locale>.ts` file imported by
 * the registry's default-pack loader. The action's own `examples` field stays
 * English-canonical.
 *
 * Usage:
 *   bun plugins/app-lifeops/scripts/translate-action-examples.mjs \
 *       plugins/app-lifeops/src/actions/life.ts \
 *       --target-locale=es \
 *       --provider=cerebras \
 *       --max-examples=3 \
 *       --action-name=life \
 *       --output=plugins/app-lifeops/src/lifeops/i18n/generated/life.es.ts
 *
 * Environment:
 *   CEREBRAS_API_KEY — required when --provider=cerebras
 *   CEREBRAS_BASE_URL — defaults to https://api.cerebras.ai/v1
 *   CEREBRAS_MODEL — defaults to gpt-oss-120b
 *
 * Failure mode: bad LLM JSON, network errors, missing keys all throw and
 * exit non-zero. No silent fallback. The harness is loud by design.
 */

import { Project, SyntaxKind } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const SUPPORTED_LOCALES = new Set(["es", "fr", "ja"]);
const DEFAULT_MODEL = "gpt-oss-120b";
const DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const elizaRoot = path.resolve(packageRoot, "..", "..");
const miladyRoot = path.resolve(elizaRoot, "..");
for (const candidate of [
  path.join(packageRoot, ".env"),
  path.join(elizaRoot, ".env"),
  path.join(miladyRoot, ".env"),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    fail(
      "Usage: translate-action-examples.mjs <action-file> --target-locale=<locale> [--provider=cerebras] [--max-examples=N] [--action-name=NAME] [--output=PATH] [--dry-run]",
    );
  }
  const result = {
    file: args[0],
    targetLocales: [],
    provider: "cerebras",
    maxExamples: Number.POSITIVE_INFINITY,
    actionName: null,
    outputPath: null,
    dryRun: false,
  };
  for (const arg of args.slice(1)) {
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg.startsWith("--target-locale=")) {
      result.targetLocales = arg
        .slice("--target-locale=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--provider=")) {
      result.provider = arg.slice("--provider=".length);
    } else if (arg.startsWith("--max-examples=")) {
      result.maxExamples = Number(arg.slice("--max-examples=".length));
    } else if (arg.startsWith("--action-name=")) {
      result.actionName = arg.slice("--action-name=".length);
    } else if (arg.startsWith("--output=")) {
      result.outputPath = arg.slice("--output=".length);
    } else {
      fail(`Unknown arg: ${arg}`);
    }
  }
  if (result.targetLocales.length === 0) {
    fail("--target-locale=<locale> is required (e.g. --target-locale=es)");
  }
  for (const locale of result.targetLocales) {
    if (!SUPPORTED_LOCALES.has(locale)) {
      fail(
        `Locale "${locale}" not supported. Supported: ${[...SUPPORTED_LOCALES].join(", ")}`,
      );
    }
  }
  if (result.provider !== "cerebras") {
    fail(`Provider "${result.provider}" not supported. Supported: cerebras`);
  }
  if (!Number.isFinite(result.maxExamples) || result.maxExamples <= 0) {
    if (result.maxExamples !== Number.POSITIVE_INFINITY) {
      fail("--max-examples must be a positive integer");
    }
  }
  return result;
}

function fail(msg) {
  console.error(`[translate-action-examples] ${msg}`);
  process.exit(1);
}

/**
 * Extract the action `name` literal and the `examples` array from a TS file.
 * We use ts-morph to walk the AST so we don't have to evaluate the module
 * (action files import the entire runtime; loading them in a pure-Node script
 * is not feasible).
 *
 * The harness expects a top-level `examples: ActionExample[][]` value or an
 * `examples` property in an exported Action literal. The first one found is
 * returned.
 */
function extractFromActionFile(filePath, actionNameOverride) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  const sourceFile = project.addSourceFileAtPath(filePath);

  // Find the examples array.
  let examplesNode = null;

  // Strategy 1: top-level `const examples: ActionExample[][] = [...]`
  for (const stmt of sourceFile.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      if (decl.getName() === "examples") {
        const init = decl.getInitializer();
        if (init && init.getKind() === SyntaxKind.ArrayLiteralExpression) {
          examplesNode = init;
        }
      }
    }
  }

  // Strategy 2: `examples: [...]` property inside an exported Action literal.
  // Action.examples is `ActionExample[][]` — an array of pair arrays. Parameter
  // schemas may also expose `examples: ["a", "b"]`, so we explicitly require the
  // outer array's first element to itself be an array literal (the `[user, agent]`
  // pair shape) before accepting the match. This avoids picking up a parameter's
  // example list and missing the real Action examples below it.
  let actionLiteral = null; // the surrounding ObjectLiteralExpression, if any
  if (!examplesNode) {
    sourceFile.forEachDescendant((node) => {
      if (examplesNode) return;
      if (node.getKind() !== SyntaxKind.PropertyAssignment) return;
      const prop = node;
      const nameNode = prop.getNameNode?.();
      if (!nameNode || nameNode.getText() !== "examples") return;
      const init = prop.getInitializer?.();
      if (!init) return;
      let candidate = null;
      if (init.getKind() === SyntaxKind.ArrayLiteralExpression) {
        candidate = init;
      } else if (init.getKind() === SyntaxKind.AsExpression) {
        const inner = init.getExpression?.();
        if (inner && inner.getKind() === SyntaxKind.ArrayLiteralExpression) {
          candidate = inner;
        }
      }
      if (!candidate) return;
      // Require ActionExample[][] shape: at least one inner element that is
      // itself an ArrayLiteralExpression. Empty arrays are accepted (action
      // with no examples — caller will get pairs=0 cleanly).
      const elements = candidate.getElements();
      const looksLikePairArray =
        elements.length === 0 ||
        elements.some(
          (el) => el.getKind() === SyntaxKind.ArrayLiteralExpression,
        );
      if (!looksLikePairArray) return;
      examplesNode = candidate;
      actionLiteral = prop.getParentIfKind?.(
        SyntaxKind.ObjectLiteralExpression,
      );
    });
  }

  if (!examplesNode) {
    fail(`Could not locate an 'examples' array literal in ${filePath}`);
  }

  // Extract name=`X` field from the SAME object literal that owns the
  // examples (so we don't pick up a parameter literal's `name` field). Fall
  // back to scanning sibling Action literals only if the same-literal lookup
  // fails.
  let actionName = actionNameOverride;
  if (!actionName && actionLiteral) {
    for (const prop of actionLiteral.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const nameNode = prop.getNameNode?.();
      if (!nameNode || nameNode.getText() !== "name") continue;
      const init = prop.getInitializer?.();
      if (!init) continue;
      if (init.getKind() === SyntaxKind.StringLiteral) {
        actionName = init.getLiteralValue();
        break;
      }
    }
  }
  if (!actionName) {
    // Strategy 3 fallback: top-level `examples` const + a separate Action
    // literal in the same file. Find any object literal that has BOTH a
    // string `name` and references the top-level `examples` identifier or a
    // `validate` field (Action shape signal).
    sourceFile.forEachDescendant((node) => {
      if (actionName) return;
      if (node.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
      const obj = node;
      let candidateName = null;
      let looksLikeAction = false;
      for (const prop of obj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const propNameNode = prop.getNameNode?.();
        const propName = propNameNode?.getText();
        const init = prop.getInitializer?.();
        if (
          propName === "name" &&
          init?.getKind() === SyntaxKind.StringLiteral
        ) {
          candidateName = init.getLiteralValue();
        }
        if (propName === "validate" || propName === "handler") {
          looksLikeAction = true;
        }
      }
      if (looksLikeAction && candidateName) {
        actionName = candidateName;
      }
    });
  }
  if (!actionName) {
    fail(
      `Could not locate action name in ${filePath}; pass --action-name=NAME explicitly`,
    );
  }

  // Convert each example pair (the inner array) into a plain-JSON-able shape.
  const pairs = [];
  const elements = examplesNode.getElements();
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element.getKind() !== SyntaxKind.ArrayLiteralExpression) {
      // Skip non-literal pairs (e.g. spread of `getDefaultPromptExamplePair`).
      continue;
    }
    const pair = parseExamplePair(element, i, filePath);
    if (pair) {
      pairs.push({ ...pair, index: i });
    }
  }

  return { actionName, pairs };
}

/**
 * Parse one `[user, agent]` example pair into a plain JS object. We accept
 * only the two-element shape with `name` + `content.text` (+ optional
 * `actions` / `action`). Anything more exotic (spreads, computed keys) is
 * skipped so the harness can't accidentally translate something unsafe.
 */
function parseExamplePair(arrayLiteral, index, filePath) {
  const elements = arrayLiteral.getElements();
  if (elements.length < 2) return null;

  const turns = [];
  for (let t = 0; t < Math.min(2, elements.length); t++) {
    const turn = elements[t];
    if (turn.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const props = turn.getProperties();
    let name = null;
    let text = null;
    let actions = null;
    let action = null;
    for (const prop of props) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const nameNode = prop.getNameNode?.();
      const propName = nameNode?.getText();
      const init = prop.getInitializer?.();
      if (!init) continue;
      if (propName === "name" && init.getKind() === SyntaxKind.StringLiteral) {
        name = init.getLiteralValue();
      } else if (
        propName === "content" &&
        init.getKind() === SyntaxKind.ObjectLiteralExpression
      ) {
        for (const cprop of init.getProperties()) {
          if (cprop.getKind() !== SyntaxKind.PropertyAssignment) continue;
          const cname = cprop.getNameNode?.()?.getText();
          const cinit = cprop.getInitializer?.();
          if (!cinit) continue;
          if (cname === "text") {
            if (
              cinit.getKind() === SyntaxKind.StringLiteral ||
              cinit.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
            ) {
              text = cinit.getLiteralValue();
            }
          } else if (
            cname === "actions" &&
            cinit.getKind() === SyntaxKind.ArrayLiteralExpression
          ) {
            actions = cinit
              .getElements()
              .filter((e) => e.getKind() === SyntaxKind.StringLiteral)
              .map((e) => e.getLiteralValue());
          } else if (
            cname === "action" &&
            cinit.getKind() === SyntaxKind.StringLiteral
          ) {
            action = cinit.getLiteralValue();
          }
        }
      }
    }
    if (!name || text == null) {
      console.warn(
        `[translate-action-examples] skipping pair #${index} in ${path.basename(
          filePath,
        )}: missing name or text`,
      );
      return null;
    }
    turns.push({ name, content: { text, actions, action } });
  }

  return { user: turns[0], agent: turns[1] };
}

/**
 * Build the strict translation prompt. The model returns one JSON object
 * with `userText` + `agentText`. We deliberately do NOT ask it to translate
 * speaker names, action tokens, or `{{name1}}`/`{{agentName}}` placeholders.
 */
function buildTranslationPrompt(pair, locale) {
  const localeName = {
    es: "Spanish (es)",
    fr: "French (fr)",
    ja: "Japanese (ja)",
  }[locale];
  return [
    `You translate an ActionExample dialog pair from English into ${localeName}.`,
    "",
    "Rules:",
    "- Translate ONLY the user message text and the agent reply text.",
    "- DO NOT translate or alter speaker placeholders like {{name1}} or {{agentName}}.",
    "- DO NOT translate action tokens (e.g. LIFE, MESSAGE_HANDOFF, SCHEDULED_TASK).",
    "- Preserve tone, terseness, and confirm/preview semantics if present.",
    "- DO NOT introduce PII (names, phones, emails) that wasn't in the input.",
    "- Numbers, times (8 am / 9 pm), monetary amounts, and quoted titles stay as-is unless idiomatic in the target locale.",
    '- Output ONLY a JSON object: {"userText": "...", "agentText": "..."} — no prose, no fences.',
    "",
    "Source pair:",
    JSON.stringify(
      { userText: pair.user.content.text, agentText: pair.agent.content.text },
      null,
      2,
    ),
  ].join("\n");
}

async function callCerebras(prompt) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    fail("CEREBRAS_API_KEY is not set");
  }
  const baseUrl = process.env.CEREBRAS_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.CEREBRAS_MODEL ?? DEFAULT_MODEL;
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a careful translator. Output JSON only. Never add commentary.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 1024,
  };
  if (model.startsWith("gpt-oss")) {
    body.reasoning_effort = "low";
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `cerebras error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error("cerebras returned empty content");
  }
  return text;
}

function parseTranslationJson(raw) {
  // Tolerate a leading ```json fence purely on the off-chance the model
  // ignores instructions; throw on anything else (no silent fallback).
  let body = raw.trim();
  if (body.startsWith("```")) {
    const firstNewline = body.indexOf("\n");
    body = body.slice(firstNewline + 1);
    const lastFence = body.lastIndexOf("```");
    if (lastFence >= 0) body = body.slice(0, lastFence);
    body = body.trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `Could not parse translation JSON: ${err instanceof Error ? err.message : String(err)}\nRaw: ${raw.slice(0, 400)}`,
    );
  }
  if (
    typeof parsed?.userText !== "string" ||
    typeof parsed?.agentText !== "string" ||
    parsed.userText.length === 0 ||
    parsed.agentText.length === 0
  ) {
    throw new Error(
      `Translation JSON missing userText/agentText:\n${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

/**
 * Render the final TypeScript file: a self-registering pack that calls
 * `registry.register(...)` for each translated pair, keyed
 * `<actionName>.example.<index>:<locale>` so the registry composite key is
 * unique. Action authors then call
 * `getDefaultPromptExamplePair("<actionName>.example.<index>", "es")` to
 * pull the pair into their `examples` array (mirrors the W2-E pattern).
 */
function renderRegistryPack({ actionName, locale, translations }) {
  const lines = [];
  lines.push(
    "// AUTOGENERATED by plugins/app-lifeops/scripts/translate-action-examples.mjs",
  );
  lines.push("// Do not edit by hand. Re-run the harness to regenerate.");
  lines.push(`// action: ${actionName}`);
  lines.push(`// locale: ${locale}`);
  lines.push("");
  lines.push(
    'import type { PromptExampleEntry } from "../prompt-registry.js";',
  );
  lines.push("");
  lines.push(`export const ${packVarName(actionName, locale)}: ReadonlyArray<PromptExampleEntry> = [`);
  for (const t of translations) {
    const key = `${actionName}.example.${t.index}`;
    const userActions = t.userActions ? actionsLiteral(t.userActions) : "";
    const userAction = t.userAction ? `, action: ${jsonString(t.userAction)}` : "";
    const agentActions = t.agentActions ? actionsLiteral(t.agentActions) : "";
    const agentAction = t.agentAction
      ? `, action: ${jsonString(t.agentAction)}`
      : "";
    lines.push("  {");
    lines.push(`    exampleKey: ${jsonString(key)},`);
    lines.push(`    locale: ${jsonString(locale)},`);
    lines.push(`    user: {`);
    lines.push(`      name: ${jsonString(t.userName)},`);
    lines.push(
      `      content: { text: ${jsonString(t.userText)}${userActions}${userAction} },`,
    );
    lines.push(`    },`);
    lines.push(`    agent: {`);
    lines.push(`      name: ${jsonString(t.agentName)},`);
    lines.push(
      `      content: { text: ${jsonString(t.agentText)}${agentActions}${agentAction} },`,
    );
    lines.push(`    },`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

function packVarName(actionName, locale) {
  const safe = actionName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${safe}_${locale}_examples`;
}

function jsonString(value) {
  return JSON.stringify(value);
}

function actionsLiteral(arr) {
  return `, actions: [${arr.map(jsonString).join(", ")}]`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const absInput = path.isAbsolute(opts.file)
    ? opts.file
    : path.resolve(process.cwd(), opts.file);
  if (!fs.existsSync(absInput)) {
    fail(`Action file not found: ${absInput}`);
  }
  const { actionName, pairs } = extractFromActionFile(absInput, opts.actionName);
  const cap = Math.min(opts.maxExamples, pairs.length);
  const subset = pairs.slice(0, cap);

  console.info(
    `[translate-action-examples] action="${actionName}" file="${path.relative(
      process.cwd(),
      absInput,
    )}" pairs=${pairs.length} translating=${subset.length} locales=${opts.targetLocales.join(",")}`,
  );

  const summary = { calls: 0, written: [] };

  for (const locale of opts.targetLocales) {
    const translations = [];
    for (const pair of subset) {
      const prompt = buildTranslationPrompt(pair, locale);
      let raw;
      if (opts.dryRun) {
        raw = JSON.stringify({
          userText: `[dry-run:${locale}] ${pair.user.content.text}`,
          agentText: `[dry-run:${locale}] ${pair.agent.content.text}`,
        });
      } else {
        raw = await callCerebras(prompt);
        summary.calls += 1;
      }
      const { userText, agentText } = parseTranslationJson(raw);
      translations.push({
        index: pair.index,
        userName: pair.user.name,
        userText,
        userActions: pair.user.content.actions ?? null,
        userAction: pair.user.content.action ?? null,
        agentName: pair.agent.name,
        agentText,
        agentActions: pair.agent.content.actions ?? null,
        agentAction: pair.agent.content.action ?? null,
      });
      console.info(
        `[translate-action-examples]   pair[${pair.index}] -> ${locale}: ${userText.slice(0, 60)}...`,
      );
    }

    const rendered = renderRegistryPack({ actionName, locale, translations });

    if (opts.outputPath) {
      const outPath = path.isAbsolute(opts.outputPath)
        ? opts.outputPath
        : path.resolve(process.cwd(), opts.outputPath);
      // When multiple locales are passed, splice locale into filename.
      const finalPath =
        opts.targetLocales.length === 1
          ? outPath
          : outPath.replace(/(\.[a-z]+)$/, `.${locale}$1`);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, rendered, "utf8");
      summary.written.push(finalPath);
      console.info(
        `[translate-action-examples]   wrote ${path.relative(process.cwd(), finalPath)}`,
      );
    } else {
      process.stdout.write(`\n// ===== ${locale} =====\n${rendered}\n`);
    }
  }

  console.info(
    `[translate-action-examples] done. cerebras_calls=${summary.calls} files_written=${summary.written.length}`,
  );
}

await main();
