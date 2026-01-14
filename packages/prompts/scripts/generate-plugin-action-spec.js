#!/usr/bin/env node
/**
 * Generate plugin action docs spec (best-effort).
 *
 * Scans plugins/** TypeScript action definitions and emits a merged spec file:
 *   packages/prompts/specs/actions/plugins.generated.json
 *
 * This is intentionally dependency-free and uses a small brace-aware extractor to
 * locate `export const X: Action = { ... }` blocks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PROMPTS_ROOT = path.resolve(__dirname, "..");

const CORE_ACTIONS_SPEC_PATH = path.join(
  PROMPTS_ROOT,
  "specs",
  "actions",
  "core.json",
);
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");
const OUTPUT_PATH = path.join(
  PROMPTS_ROOT,
  "specs",
  "actions",
  "plugins.generated.json",
);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listTsFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // ignore generated + dist trees
        if (
          ent.name === "dist" ||
          ent.name === "generated" ||
          ent.name === "node_modules"
        ) {
          continue;
        }
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith(".ts")) {
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
        if (full.endsWith(".test.ts")) continue;
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Extract object literal source for `export const X: Action = { ... }`.
 * Returns array of `{ filePath, objectText }`.
 */
function extractActionObjects(filePath, src) {
  const results = [];
  const re = /:\s*Action\s*=\s*\{/gm;
  for (;;) {
    const m = re.exec(src);
    if (m === null) break;
    const braceStart = m.index + m[0].lastIndexOf("{");

    // Parse balanced braces, skipping strings and comments.
    let depth = 0;
    let j = braceStart;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    while (j < src.length) {
      const ch = src[j];
      const next = j + 1 < src.length ? src[j + 1] : "";

      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        j++;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }

      if (!inSingle && !inDouble && !inTemplate) {
        if (ch === "/" && next === "/") {
          inLineComment = true;
          j += 2;
          continue;
        }
        if (ch === "/" && next === "*") {
          inBlockComment = true;
          j += 2;
          continue;
        }
      }

      if (inSingle) {
        if (!escaped && ch === "'") inSingle = false;
        escaped = !escaped && ch === "\\";
        j++;
        continue;
      }
      if (inDouble) {
        if (!escaped && ch === '"') inDouble = false;
        escaped = !escaped && ch === "\\";
        j++;
        continue;
      }
      if (inTemplate) {
        if (!escaped && ch === "`") {
          inTemplate = false;
          j++;
          continue;
        }
        escaped = !escaped && ch === "\\";
        j++;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        j++;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        j++;
        continue;
      }
      if (ch === "`") {
        inTemplate = true;
        j++;
        continue;
      }

      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          const objectText = src.slice(braceStart, j + 1);
          results.push({ filePath, objectText });
          break;
        }
      }

      j++;
    }
  }

  return results;
}

function unquoteStringLiteral(s) {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    // Best-effort unescape: handle common escapes.
    const inner = trimmed.slice(1, -1);
    return inner
      .replaceAll("\\n", "\n")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\'", "'")
      .replaceAll("\\\\", "\\");
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  return null;
}

function isWs(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function scanTopLevelPropertyValue(objText, propName) {
  // objText is `{ ... }`
  let i = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  while (i < objText.length) {
    const ch = objText[i];
    const next = i + 1 < objText.length ? objText[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }
    if (inDouble) {
      if (!escaped && ch === '"') inDouble = false;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }
    if (inTemplate) {
      if (!escaped && ch === "`") inTemplate = false;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i++;
      continue;
    }

    if (ch === "{") braceDepth++;
    if (ch === "}") braceDepth--;
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth--;

    // Top-level inside the object: braceDepth === 1
    if (braceDepth === 1 && bracketDepth === 0) {
      // Look for `<propName>:` starting at identifier boundary.
      if (objText.startsWith(propName, i)) {
        const before = i > 0 ? objText[i - 1] : "";
        const after =
          i + propName.length < objText.length
            ? objText[i + propName.length]
            : "";
        const beforeOk = before === "" || !/[A-Za-z0-9_$]/.test(before);
        const afterOk = after === "" || isWs(after) || after === ":";
        if (beforeOk && afterOk) {
          let j = i + propName.length;
          while (j < objText.length && isWs(objText[j])) j++;
          if (objText[j] !== ":") {
            i++;
            continue;
          }
          j++;
          while (j < objText.length && isWs(objText[j])) j++;
          return objText.slice(j);
        }
      }
    }

    i++;
  }

  return null;
}

function extractTopLevelStringProp(objText, propName) {
  const tail = scanTopLevelPropertyValue(objText, propName);
  if (!tail) return null;
  // Parse a single string literal token.
  const first = tail.trimStart();
  if (
    !(first.startsWith('"') || first.startsWith("'") || first.startsWith("`"))
  ) {
    return null;
  }

  // Grab up to the end of the literal (best-effort, supports escaped quotes).
  const quote = first[0];
  let i = 1;
  let escaped = false;
  while (i < first.length) {
    const ch = first[i];
    if (!escaped && ch === quote) break;
    escaped = !escaped && ch === "\\";
    i++;
  }
  if (i >= first.length) return null;
  return unquoteStringLiteral(first.slice(0, i + 1));
}

function extractTopLevelStringArrayProp(objText, propName) {
  const tail = scanTopLevelPropertyValue(objText, propName);
  if (!tail) return [];
  const first = tail.trimStart();
  if (!first.startsWith("[")) return [];
  let depth = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  while (i < first.length) {
    const ch = first[i];
    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }
    if (inDouble) {
      if (!escaped && ch === '"') inDouble = false;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }
    if (inTemplate) {
      if (!escaped && ch === "`") inTemplate = false;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i++;
      continue;
    }

    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0) return [];
  const inner = first.slice(1, i);
  const vals = [];
  const strRe = /(["'`])((?:\\.|(?!\1).)*)\1/gm;
  for (;;) {
    const m = strRe.exec(inner);
    if (m === null) break;
    const quote = m[1];
    const raw = quote + m[2] + quote;
    const unq = unquoteStringLiteral(raw);
    if (typeof unq === "string") vals.push(unq);
  }
  return vals;
}

function main() {
  const core = readJson(CORE_ACTIONS_SPEC_PATH);
  const version = typeof core.version === "string" ? core.version : "1.0.0";
  const coreActionNames = new Set(
    Array.isArray(core.actions)
      ? core.actions
          .map((a) => (a && typeof a === "object" ? a.name : null))
          .filter((n) => typeof n === "string")
      : [],
  );

  const commonParamDocs = new Map([
    [
      "url",
      {
        description: "The URL to navigate to.",
        example: "https://example.com",
      },
    ],
    [
      "owner",
      { description: "Repository owner or organization.", example: "octocat" },
    ],
    ["repo", { description: "Repository name.", example: "my-repo" }],
    ["branch", { description: "Branch name.", example: "main" }],
    ["base", { description: "Base branch to merge into.", example: "main" }],
    [
      "head",
      {
        description: "Head branch to merge from.",
        example: "feature/dark-mode",
      },
    ],
    [
      "title",
      {
        description: "Title for the operation.",
        example: "Add dark mode support",
      },
    ],
    [
      "body",
      {
        description: "Body text for the operation.",
        example: "Implements dark mode and updates docs.",
      },
    ],
    ["draft", { description: "Whether to create as draft.", example: false }],
    [
      "channelId",
      {
        description: "Target channel identifier.",
        example: "123456789012345678",
      },
    ],
    [
      "userId",
      { description: "Target user identifier.", example: "123456789012345678" },
    ],
    [
      "message",
      {
        description: "Message text to send.",
        example: "Hello! How can I help?",
      },
    ],
    ["amount", { description: "Amount to use (as a string).", example: "0.1" }],
    [
      "fromToken",
      {
        description: "Source token address or symbol.",
        example: "0x0000000000000000000000000000000000000000",
      },
    ],
    [
      "toToken",
      {
        description: "Destination token address or symbol.",
        example: "0x0000000000000000000000000000000000000000",
      },
    ],
    [
      "chain",
      { description: "Chain identifier or name.", example: "ethereum" },
    ],
    ["slippage", { description: "Max slippage percentage.", example: 1 }],
  ]);

  function humanizeKey(key) {
    return key
      .replaceAll(/[_-]+/g, " ")
      .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase();
  }

  function inferParamType(objText, key) {
    const re = new RegExp(`state\\?\\.${key}\\s+as\\s+([A-Za-z0-9_]+)`, "g");
    const m = re.exec(objText);
    const t = m?.[1];
    if (t === "boolean") return "boolean";
    if (t === "number") return "number";
    return "string";
  }

  function inferParameters(objText) {
    const keys = new Set();
    const keyRe = /state\?\.\s*([A-Za-z0-9_]+)/g;
    for (;;) {
      const m = keyRe.exec(objText);
      if (m === null) break;
      keys.add(m[1]);
    }

    const params = [];
    for (const key of Array.from(keys).sort((a, b) => a.localeCompare(b))) {
      const type = inferParamType(objText, key);
      const known = commonParamDocs.get(key);
      const description =
        known?.description ?? `The ${humanizeKey(key)} to use.`;
      const example =
        known?.example ??
        (type === "boolean" ? false : type === "number" ? 1 : "example");
      params.push({
        name: key,
        description,
        required: false,
        schema: { type },
        examples: [example],
      });
    }

    return params;
  }

  function buildExampleCallForAction(actionName, params) {
    if (!params || params.length === 0) {
      return [];
    }
    /** @type {Record<string, string | number | boolean | null>} */
    const sampleParams = {};
    for (const p of params) {
      const ex =
        Array.isArray(p.examples) && p.examples.length > 0
          ? p.examples[0]
          : null;
      sampleParams[p.name] =
        typeof ex === "string" ||
        typeof ex === "number" ||
        typeof ex === "boolean" ||
        ex === null
          ? ex
          : "example";
    }
    return [
      {
        user: `Use ${actionName} with the provided parameters.`,
        actions: [actionName],
        params: {
          [actionName]: sampleParams,
        },
      },
    ];
  }

  const tsFiles = listTsFiles(PLUGINS_ROOT);
  const actionDocsByName = new Map();

  for (const filePath of tsFiles) {
    // Only consider files that look like they might define actions.
    if (
      !filePath.includes(`${path.sep}actions${path.sep}`) &&
      !filePath.endsWith(`${path.sep}actions.ts`)
    ) {
      continue;
    }
    const src = readText(filePath);
    if (!src.includes(": Action")) continue;

    const objects = extractActionObjects(filePath, src);
    for (const obj of objects) {
      const name = extractTopLevelStringProp(obj.objectText, "name");
      if (!name) continue;
      if (coreActionNames.has(name)) continue;
      const description =
        extractTopLevelStringProp(obj.objectText, "description") ?? "";
      const similes = extractTopLevelStringArrayProp(obj.objectText, "similes");
      const parameters = inferParameters(obj.objectText);
      const exampleCalls = buildExampleCallForAction(name, parameters);

      // Do not overwrite existing entries; prefer the first seen (stable ordering).
      if (!actionDocsByName.has(name)) {
        actionDocsByName.set(name, {
          name,
          description,
          similes: similes.length > 0 ? similes : undefined,
          parameters,
          exampleCalls,
        });
      }
    }
  }

  const actions = Array.from(actionDocsByName.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => {
      const out = {
        name: a.name,
        description: a.description,
        parameters: a.parameters,
      };
      if (a.similes) out.similes = a.similes;
      if (a.exampleCalls && a.exampleCalls.length > 0) {
        out.exampleCalls = a.exampleCalls;
      }
      return out;
    });

  const outRoot = { version, actions };

  ensureDir(path.dirname(OUTPUT_PATH));
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(outRoot, null, 2)}\n`);
  console.log(
    `Wrote ${actions.length} plugin actions to ${path.relative(REPO_ROOT, OUTPUT_PATH)}`,
  );
}

main();
