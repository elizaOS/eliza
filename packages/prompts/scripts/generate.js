#!/usr/bin/env node

/**
 * Prompt Generator Script
 *
 * Generates TypeScript code from .txt prompt templates.
 *
 * Usage:
 *   node scripts/generate.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PROMPTS_DIR = path.join(ROOT_DIR, "prompts");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const CORE_OUTPUT = path.resolve(ROOT_DIR, "..", "core", "src", "prompts.ts");

const STANDARD_JSON_FOOTER =
  "JSON only. Return one JSON object. No prose, fences, thinking, or markdown.";

/**
 * Files that are sources for codegen-derived constants. They are NOT emitted
 * directly under their own constant name; instead, named variants are emitted
 * by the special-case logic below.
 */
const HIDDEN_SOURCE_FILES = new Set([
  "should_change_room_state.txt",
  "autonomy.txt",
  "reflection_evaluator.txt",
]);

/**
 * Files whose .txt is kept on disk for back-compat but whose generated TS
 * constant should be replaced by the consolidated source. We synthesize these
 * derived constants from the consolidated templates.
 */
const ROOM_STATE_DERIVATIONS = [
  { file: "should_follow_room.txt", action: "follow" },
  { file: "should_mute_room.txt", action: "mute" },
  { file: "should_unfollow_room.txt", action: "unfollow" },
  { file: "should_unmute_room.txt", action: "unmute" },
];

const AUTONOMY_DERIVATIONS = [
  { file: "autonomy_continuous_first.txt", isTask: false, isContinue: false },
  { file: "autonomy_continuous_continue.txt", isTask: false, isContinue: true },
  { file: "autonomy_task_first.txt", isTask: true, isContinue: false },
  { file: "autonomy_task_continue.txt", isTask: true, isContinue: true },
];

const ROOM_STATE_FILES = new Set(ROOM_STATE_DERIVATIONS.map((d) => d.file));
const AUTONOMY_DERIVED_FILES = new Set(AUTONOMY_DERIVATIONS.map((d) => d.file));
const SHOULD_RESPOND_WITH_CONTEXT_FILE = "should_respond_with_context.txt";

function fileToConstName(filename) {
  const name = path.basename(filename, ".txt");
  return `${name.toUpperCase().replace(/-/g, "_")}_TEMPLATE`;
}

function fileToCamelCase(filename) {
  const name = path.basename(filename, ".txt");
  const parts = name.split("_");
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("") +
    "Template"
  );
}

function escapeTypeScript(content) {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/**
 * Append the standardized JSON-only footer to prompts that produce JSON.
 * Heuristic: if the prompt body mentions "JSON" anywhere, append the footer.
 */
function withJsonFooter(content) {
  if (content.includes(STANDARD_JSON_FOOTER)) return content;
  // Skip prompts that produce non-JSON (boolean/YAML) output.
  if (/^decision:\s*(true|false)/m.test(content)) return content;
  // Append for everything else; almost all prompts emit JSON or JSON-shaped output.
  return `${content.trimEnd()}\n\n${STANDARD_JSON_FOOTER}\n`;
}

/**
 * Render a tiny subset of Handlebars: `{{#if NAME}}A{{else}}B{{/if}}` and
 * `{{NAME}}` with arbitrary nesting. Used at codegen time to derive variant
 * constants from a single consolidated source.
 */
function renderTemplate(source, vars) {
  function consume(input) {
    let out = "";
    let i = 0;
    while (i < input.length) {
      if (input.startsWith("{{#if ", i)) {
        const close = input.indexOf("}}", i);
        const name = input.slice(i + 6, close).trim();
        const rest = input.slice(close + 2);
        const { thenBlock, elseBlock, end } = splitIfBlock(rest);
        const branch = vars[name] ? thenBlock : elseBlock;
        out += consume(branch);
        i = close + 2 + end;
      } else if (input.startsWith("{{", i)) {
        const close = input.indexOf("}}", i);
        const name = input.slice(i + 2, close).trim();
        if (name in vars && typeof vars[name] === "string") {
          out += vars[name];
        } else {
          out += `{{${name}}}`;
        }
        i = close + 2;
      } else {
        out += input[i];
        i++;
      }
    }
    return out;
  }

  function splitIfBlock(input) {
    let depth = 1;
    let i = 0;
    let elseAt = -1;
    while (i < input.length) {
      if (input.startsWith("{{#if ", i)) {
        depth++;
        i = input.indexOf("}}", i) + 2;
      } else if (input.startsWith("{{else}}", i)) {
        if (depth === 1 && elseAt === -1) {
          elseAt = i;
        }
        i += "{{else}}".length;
      } else if (input.startsWith("{{/if}}", i)) {
        depth--;
        if (depth === 0) {
          const end = i + "{{/if}}".length;
          if (elseAt === -1) {
            return { thenBlock: input.slice(0, i), elseBlock: "", end };
          }
          return {
            thenBlock: input.slice(0, elseAt),
            elseBlock: input.slice(elseAt + "{{else}}".length, i),
            end,
          };
        }
        i += "{{/if}}".length;
      } else {
        i++;
      }
    }
    throw new Error("unterminated {{#if}} block");
  }

  return consume(source);
}

function loadPrompts() {
  const prompts = [];
  const files = fs.readdirSync(PROMPTS_DIR);
  const rawByName = new Map();

  for (const file of files) {
    if (!file.endsWith(".txt")) continue;
    const filepath = path.join(PROMPTS_DIR, file);
    const content = fs.readFileSync(filepath, "utf-8").trim();
    rawByName.set(file, content);
  }

  // Direct prompts (one-to-one with .txt files)
  for (const [file, raw] of rawByName) {
    if (HIDDEN_SOURCE_FILES.has(file)) continue;
    if (ROOM_STATE_FILES.has(file)) continue;
    if (AUTONOMY_DERIVED_FILES.has(file)) continue;
    if (file === SHOULD_RESPOND_WITH_CONTEXT_FILE) continue;

    prompts.push({
      filename: file,
      constName: fileToConstName(file),
      camelName: fileToCamelCase(file),
      content: withJsonFooter(raw),
    });
  }

  // Derived: room state variants
  const roomSource = rawByName.get("should_change_room_state.txt");
  if (roomSource) {
    for (const { file, action } of ROOM_STATE_DERIVATIONS) {
      const rendered = renderTemplate(roomSource, { action });
      prompts.push({
        filename: file,
        constName: fileToConstName(file),
        camelName: fileToCamelCase(file),
        content: rendered,
      });
    }
  }

  // Derived: autonomy variants
  const autonomySource = rawByName.get("autonomy.txt");
  if (autonomySource) {
    for (const { file, isTask, isContinue } of AUTONOMY_DERIVATIONS) {
      const rendered = renderTemplate(autonomySource, {
        isTask,
        isContinue,
      });
      prompts.push({
        filename: file,
        constName: fileToConstName(file),
        camelName: fileToCamelCase(file),
        content: withJsonFooter(rendered),
      });
    }
  }

  // Back-compat: should_respond_with_context aliases the merged should_respond
  const shouldRespondSource = rawByName.get("should_respond.txt");
  if (shouldRespondSource) {
    prompts.push({
      filename: SHOULD_RESPOND_WITH_CONTEXT_FILE,
      constName: fileToConstName(SHOULD_RESPOND_WITH_CONTEXT_FILE),
      camelName: fileToCamelCase(SHOULD_RESPOND_WITH_CONTEXT_FILE),
      content: withJsonFooter(shouldRespondSource),
    });
  }

  return prompts.sort((a, b) => a.constName.localeCompare(b.constName));
}

function buildOutput(prompts) {
  let output = `/**
 * Auto-generated prompt templates for elizaOS
 * DO NOT EDIT - Generated from packages/prompts/prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

`;

  for (const prompt of prompts) {
    const escaped = escapeTypeScript(prompt.content);
    output += `export const ${prompt.camelName} = \`${escaped}\`;\n\n`;
    output += `export const ${prompt.constName} = ${prompt.camelName};\n\n`;
  }

  output += `export const booleanFooter = "Respond with only a YES or a NO.";\n\n`;
  output += `export const BOOLEAN_FOOTER = booleanFooter;\n`;
  return output;
}

function buildDts(prompts) {
  let dts = `/**
 * Auto-generated type definitions for elizaOS prompts
 */

`;
  for (const prompt of prompts) {
    dts += `export declare const ${prompt.camelName}: string;\n`;
    dts += `export declare const ${prompt.constName}: string;\n`;
  }
  dts += `export declare const booleanFooter: string;\n`;
  dts += `export declare const BOOLEAN_FOOTER: string;\n`;
  return dts;
}

function generateTypeScript(prompts) {
  const outputDir = path.join(DIST_DIR, "typescript");
  fs.mkdirSync(outputDir, { recursive: true });

  const indexTs = buildOutput(prompts);
  const indexDts = buildDts(prompts);

  fs.writeFileSync(path.join(outputDir, "index.ts"), indexTs);
  fs.writeFileSync(path.join(outputDir, "index.d.ts"), indexDts);

  // Also write to packages/core/src/prompts.ts (consumed by core directly).
  if (fs.existsSync(path.dirname(CORE_OUTPUT))) {
    fs.writeFileSync(CORE_OUTPUT, indexTs);
    console.log(`Wrote core consumer file: ${CORE_OUTPUT}`);
  }

  console.log(`Generated TypeScript output: ${outputDir}/index.ts`);
}

function main() {
  if (!fs.existsSync(PROMPTS_DIR)) {
    console.warn(
      `Prompt source directory not found at ${PROMPTS_DIR}; keeping existing generated outputs.`,
    );
    return;
  }

  console.log("Loading prompts...");
  const prompts = loadPrompts();
  console.log(`Found ${prompts.length} prompt templates`);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  generateTypeScript(prompts);

  console.log("Done!");
}

main();
