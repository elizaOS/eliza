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

const RETIRED_IMPLEMENTATION_ONLY_ACTIONS = new Set([
  "ASK_USER_QUESTION",
  "CHECKIN",
  "CHECK_AVAILABILITY",
  "DISCORD_SETUP_CREDENTIALS",
  "EDIT",
  "ENTER_WORKTREE",
  "EXIT_WORKTREE",
  "FIRST_RUN",
  "FORM_RESTORE",
  "GET_TUNNEL_STATUS",
  "GLOB",
  "GREP",
  "HEALTH",
  "LIFE",
  "LIFEOPS",
  "LIST_ACTIVE_BLOCKS",
  "PROFILE",
  "RELATIONSHIP",
  "MONEY",
  "PAYMENTS",
  "SUBSCRIPTIONS",
  "SCHEDULE",
  "BOOK_TRAVEL",
  "SCHEDULING_NEGOTIATION",
  "DEVICE_INTENT",
  "MESSAGE_HANDOFF",
  "APP_BLOCK",
  "WEBSITE_BLOCK",
  "AUTOFILL",
  "PASSWORD_MANAGER",
  "GOOGLE_CALENDAR",
  "LIFEOPS_PAUSE",
  "NOSTR_PUBLISH_PROFILE",
  "PAYMENT",
  "PLACE_CALL",
  "PLAY_AUDIO",
  "PLAYBACK",
  "READ",
  "RELEASE_BLOCK",
  "SCREEN_TIME",
  "TOGGLE_FEATURE",
  "TAILSCALE",
  "START_TUNNEL",
  "STOP_TUNNEL",
  "WEB_FETCH",
  "WRITE",
  "LS",
  "MUSIC_LIBRARY",
  "LIST_OVERDUE_FOLLOWUPS",
  "MARK_FOLLOWUP_DONE",
  "SET_FOLLOWUP_THRESHOLD",
  "LINEAR_ISSUE",
  "LINEAR_COMMENT",
  "LINEAR_WORKFLOW",
  "CREATE_LINEAR_ISSUE",
  "GET_LINEAR_ISSUE",
  "UPDATE_LINEAR_ISSUE",
  "DELETE_LINEAR_ISSUE",
  "CREATE_LINEAR_COMMENT",
  "UPDATE_LINEAR_COMMENT",
  "DELETE_LINEAR_COMMENT",
  "LIST_LINEAR_COMMENTS",
  "GET_LINEAR_ACTIVITY",
  "CLEAR_LINEAR_ACTIVITY",
  "SEARCH_LINEAR_ISSUES",
]);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

/**
 * Template literals are extracted as raw source text; expand known `${...}` patterns
 * so generated JSON/docs contain real strings (Biome flags `${` inside quoted TS strings).
 * @param {string} description
 * @param {string} actionFilePath
 * @returns {string}
 */
function expandDescriptionTemplateLiterals(description, actionFilePath) {
  if (!description.includes("${VALID_EMOTE_IDS.join")) {
    return description;
  }
  const emotesPath = path.join(path.dirname(actionFilePath), "emotes.ts");
  if (!fs.existsSync(emotesPath)) {
    console.warn(
      `[generate-plugin-action-spec] VALID_EMOTE_IDS placeholder but missing ${emotesPath}`,
    );
    return description;
  }
  const emotesSrc = readText(emotesPath);
  const block = emotesSrc.match(
    /export\s+const\s+VALID_EMOTE_IDS\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!block) {
    console.warn(
      `[generate-plugin-action-spec] Could not parse VALID_EMOTE_IDS in ${emotesPath}`,
    );
    return description;
  }
  /** @type {string[]} */
  const ids = [];
  const idRe = /"([a-zA-Z0-9_-]+)"/g;
  let match = idRe.exec(block[1]);
  while (match !== null) {
    ids.push(match[1]);
    match = idRe.exec(block[1]);
  }
  if (ids.length === 0) {
    return description;
  }
  const joined = ids.join(", ");
  return description.replace(/\$\{VALID_EMOTE_IDS\.join\([^)]*\)\}/g, joined);
}

/**
 * Ensures a directory exists, creating it and parent directories if necessary.
 * @param {string} dir - The directory path to ensure exists
 * @throws {Error} If the directory path is empty or whitespace-only
 */
function ensureDir(dir) {
  if (!dir || dir.trim() === "") {
    throw new Error("Directory path cannot be empty");
  }
  fs.mkdirSync(dir, { recursive: true });
}

function listTsFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
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
  const patterns = [
    /:\s*Action(?:\s*&\s*\{[\s\S]*?\})?\s*=\s*\{/gm,
    /\bfunction\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)\s*:\s*Action\s*\{[\s\S]*?\breturn\s+\{/gm,
  ];
  for (const re of patterns) {
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

function extractTopLevelValueSource(objText, propName) {
  const tail = scanTopLevelPropertyValue(objText, propName);
  if (!tail) return null;

  let i = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  while (i < tail.length) {
    const ch = tail[i];
    const next = i + 1 < tail.length ? tail[i + 1] : "";

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

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (ch === ",") return tail.slice(0, i).trim();
    }

    if (ch === "{") braceDepth++;
    if (ch === "}") {
      if (braceDepth === 0) return tail.slice(0, i).trim();
      braceDepth--;
    }
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth--;
    if (ch === "(") parenDepth++;
    if (ch === ")") parenDepth--;

    i++;
  }

  return tail.trim();
}

function skipTrivia(src, cursor) {
  let i = cursor;
  while (i < src.length) {
    const ch = src[i];
    const next = i + 1 < src.length ? src[i + 1] : "";
    if (isWs(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function readIdentifier(src, cursor) {
  let i = cursor;
  if (!/[A-Za-z_$]/.test(src[i] ?? "")) return null;
  i++;
  while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
  return { value: src.slice(cursor, i), end: i };
}

function readStringToken(src, cursor) {
  const quote = src[cursor];
  let i = cursor + 1;
  let escaped = false;
  while (i < src.length) {
    const ch = src[i];
    if (!escaped && ch === quote) break;
    escaped = !escaped && ch === "\\";
    i++;
  }
  if (i >= src.length) return null;
  const literal = src.slice(cursor, i + 1);
  return { value: unquoteStringLiteral(literal), end: i + 1 };
}

function readNumberToken(src, cursor) {
  const m = src.slice(cursor).match(/^-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return { value: Number(m[0]), end: cursor + m[0].length };
}

function skipUnknownExpression(src, cursor) {
  let i = cursor;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  while (i < src.length) {
    const ch = src[i];
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

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (ch === "," || ch === "}" || ch === "]") break;
    }

    if (ch === "{") braceDepth++;
    if (ch === "}") braceDepth--;
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth--;
    if (ch === "(") parenDepth++;
    if (ch === ")") parenDepth--;
    i++;
  }

  return i;
}

function skipTypeAssertionSuffix(src, cursor) {
  let i = skipTrivia(src, cursor);
  while (src.startsWith("as", i)) {
    const before = i > 0 ? src[i - 1] : "";
    const after = i + 2 < src.length ? src[i + 2] : "";
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) break;
    i = skipTrivia(src, i + 2);
    while (i < src.length && ![",", "]", "}"].includes(src[i])) i++;
    i = skipTrivia(src, i);
  }
  return i;
}

function parseTsLiteralValue(src, cursor = 0, constants = new Map()) {
  let i = skipTrivia(src, cursor);
  const ch = src[i];
  if (ch === undefined) return { value: undefined, end: i };

  if (ch === "'" || ch === '"' || ch === "`") {
    const token = readStringToken(src, i);
    if (!token) return { value: undefined, end: skipUnknownExpression(src, i) };
    return { value: token.value, end: skipTypeAssertionSuffix(src, token.end) };
  }

  if (ch === "[") {
    /** @type {unknown[]} */
    const arr = [];
    i++;
    for (;;) {
      i = skipTrivia(src, i);
      if (src[i] === "]" || i >= src.length) {
        i++;
        break;
      }
      if (src.startsWith("...", i)) {
        const ident = readIdentifier(src, skipTrivia(src, i + 3));
        if (ident && Array.isArray(constants.get(ident.value))) {
          arr.push(...constants.get(ident.value));
          i = ident.end;
        } else {
          i = skipUnknownExpression(src, i + 3);
        }
      } else {
        const parsed = parseTsLiteralValue(src, i, constants);
        if (parsed.value !== undefined) arr.push(parsed.value);
        i = parsed.end;
      }
      i = skipTrivia(src, i);
      if (src[i] === ",") i++;
    }
    return { value: arr, end: skipTypeAssertionSuffix(src, i) };
  }

  if (ch === "{") {
    /** @type {Record<string, unknown>} */
    const obj = {};
    i++;
    for (;;) {
      i = skipTrivia(src, i);
      if (src[i] === "}" || i >= src.length) {
        i++;
        break;
      }
      if (src.startsWith("...", i)) {
        i = skipUnknownExpression(src, i + 3);
        i = skipTrivia(src, i);
        if (src[i] === ",") i++;
        continue;
      }

      let key;
      if (src[i] === "'" || src[i] === '"' || src[i] === "`") {
        const token = readStringToken(src, i);
        if (!token || typeof token.value !== "string") break;
        key = token.value;
        i = token.end;
      } else {
        const ident = readIdentifier(src, i);
        if (!ident) {
          i = skipUnknownExpression(src, i);
          if (src[i] === ",") i++;
          continue;
        }
        key = ident.value;
        i = ident.end;
      }

      i = skipTrivia(src, i);
      if (src[i] !== ":") {
        obj[key] = true;
        if (src[i] === ",") i++;
        continue;
      }
      const parsed = parseTsLiteralValue(src, i + 1, constants);
      if (parsed.value !== undefined) obj[key] = parsed.value;
      i = skipTrivia(src, parsed.end);
      if (src[i] === ",") i++;
    }
    return { value: obj, end: skipTypeAssertionSuffix(src, i) };
  }

  if (ch === "-" || /\d/.test(ch)) {
    const token = readNumberToken(src, i);
    if (!token) return { value: undefined, end: skipUnknownExpression(src, i) };
    return { value: token.value, end: skipTypeAssertionSuffix(src, token.end) };
  }

  const ident = readIdentifier(src, i);
  if (ident) {
    if (constants.has(ident.value)) {
      return {
        value: constants.get(ident.value),
        end: skipTypeAssertionSuffix(src, ident.end),
      };
    }
    if (ident.value === "true") {
      return { value: true, end: skipTypeAssertionSuffix(src, ident.end) };
    }
    if (ident.value === "false") {
      return { value: false, end: skipTypeAssertionSuffix(src, ident.end) };
    }
    if (ident.value === "null") {
      return { value: null, end: skipTypeAssertionSuffix(src, ident.end) };
    }
  }

  return { value: undefined, end: skipUnknownExpression(src, i) };
}

function extractTopLevelLiteralProp(objText, propName, constants = new Map()) {
  const source = extractTopLevelValueSource(objText, propName);
  if (!source) return undefined;
  return parseTsLiteralValue(source, 0, constants).value;
}

function extractConstLiterals(src) {
  const constants = new Map();
  const re = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=]+)?\s*=\s*/gm;
  for (;;) {
    const match = re.exec(src);
    if (match === null) break;
    const name = match[1];
    const parsed = parseTsLiteralValue(src, re.lastIndex, constants);
    if (
      typeof parsed.value === "string" ||
      typeof parsed.value === "number" ||
      typeof parsed.value === "boolean" ||
      Array.isArray(parsed.value)
    ) {
      constants.set(name, parsed.value);
    }
    re.lastIndex = Math.max(parsed.end, re.lastIndex);
  }
  return constants;
}

function resolveRequireActionSpecName(src, source) {
  const match = source.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.name$/);
  if (!match) return null;
  const specName = match[1];
  const specRe = new RegExp(
    `\\bconst\\s+${specName}\\s*=\\s*requireActionSpec\\((["'\`])([^"'\`]+)\\1\\)`,
  );
  return specRe.exec(src)?.[2] ?? null;
}

function extractResolvedStringProp(objText, propName, constants, src) {
  const direct = extractTopLevelStringProp(objText, propName);
  if (typeof direct === "string") return direct;

  const source = extractTopLevelValueSource(objText, propName);
  if (!source) return null;
  const parsed = parseTsLiteralValue(source, 0, constants).value;
  if (typeof parsed === "string") return parsed;

  return resolveRequireActionSpecName(src, source);
}

function isRecordValue(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function humanizeParamKey(key) {
  return key
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function sanitizeSchema(schema) {
  if (!isRecordValue(schema) || typeof schema.type !== "string") {
    return { type: "string" };
  }
  /** @type {Record<string, unknown>} */
  const out = { type: schema.type };
  if (Array.isArray(schema.enum)) {
    const vals = schema.enum.filter((v) => typeof v === "string");
    if (vals.length > 0) out.enum = vals;
  }
  if (
    schema.default === null ||
    ["string", "number", "boolean"].includes(typeof schema.default)
  ) {
    out.default = schema.default;
  }
  if (typeof schema.minimum === "number") out.minimum = schema.minimum;
  if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  if (typeof schema.pattern === "string") out.pattern = schema.pattern;
  if (isRecordValue(schema.properties)) {
    /** @type {Record<string, unknown>} */
    const props = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = sanitizeSchema(value);
    }
    out.properties = props;
  }
  if (isRecordValue(schema.items)) {
    out.items = sanitizeSchema(schema.items);
  }
  return out;
}

function sanitizeExamples(examples) {
  if (!Array.isArray(examples)) return undefined;
  const vals = examples.filter(
    (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
  );
  return vals.length > 0 ? vals : undefined;
}

function sanitizeParameters(value) {
  if (!Array.isArray(value)) return [];
  /** @type {unknown[]} */
  const params = [];
  for (const raw of value) {
    if (!isRecordValue(raw) || typeof raw.name !== "string") continue;
    const description =
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description
        : `The ${humanizeParamKey(raw.name)} to use.`;
    /** @type {Record<string, unknown>} */
    const param = {
      name: raw.name,
      description,
      required: raw.required === true,
      schema: sanitizeSchema(raw.schema),
    };
    const examples = sanitizeExamples(raw.examples);
    if (examples) param.examples = examples;
    if (typeof raw.descriptionCompressed === "string") {
      param.descriptionCompressed = raw.descriptionCompressed;
    }
    if (typeof raw.compressedDescription === "string") {
      param.compressedDescription = raw.compressedDescription;
    }
    params.push(param);
  }
  return params;
}

function inferParameterTypeFromName(name) {
  if (
    [
      "auto_backup",
      "confirmed",
      "detailed",
      "draft",
      "dryRun",
      "remove",
    ].includes(name)
  ) {
    return "boolean";
  }
  if (
    [
      "amount",
      "bpm",
      "count",
      "duration",
      "durationMs",
      "maxResults",
      "parentFid",
      "radius",
      "slippage",
      "slippageBps",
      "timeout",
      "x",
      "y",
      "z",
    ].includes(name)
  ) {
    return "number";
  }
  return "string";
}

function buildParamDoc(name, description, schema) {
  return {
    name,
    description,
    required: false,
    schema,
  };
}

function inferParametersFromDescription(description) {
  const match = description.match(/\bParams:\s*([^.]*)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawName, rawValues] = part.split("=").map((s) => s.trim());
      const name = rawName.replace(/[^A-Za-z0-9_]/g, "");
      if (!name) return null;
      const type = inferParameterTypeFromName(name);
      const schema = { type };
      if (rawValues && type === "string") {
        const enumValues = rawValues
          .split("|")
          .map((v) => v.trim())
          .filter(Boolean);
        if (
          enumValues.length > 1 &&
          enumValues.every((v) => /^[\w-]+$/.test(v))
        ) {
          schema.enum = enumValues;
        }
      }
      return buildParamDoc(name, `Router parameter ${name}.`, schema);
    })
    .filter(Boolean);
}

function inferParametersFromJsonTemplate(src) {
  const marker = "Respond with JSON only:";
  const markerIndex = src.indexOf(marker);
  if (markerIndex < 0) return [];
  const templateEnd = src.indexOf("`", markerIndex);
  if (templateEnd < 0) return [];
  const template = src.slice(0, templateEnd);
  const descByName = new Map();
  const descRe = /^\s*\d+\.\s+([A-Za-z_][A-Za-z0-9_]*):\s+(.+)$/gm;
  for (;;) {
    const match = descRe.exec(template);
    if (match === null) break;
    descByName.set(match[1], match[2].trim());
  }

  const jsonBlock = src.slice(markerIndex + marker.length, templateEnd);
  const params = [];
  const seen = new Set();
  for (const line of jsonBlock.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const rawDefault = match[2];
    const type =
      rawDefault === "true" || rawDefault === "false"
        ? "boolean"
        : /^-?\d+(?:\.\d+)?$/.test(rawDefault)
          ? "number"
          : inferParameterTypeFromName(name);
    const schema = { type };
    if (rawDefault === "true" || rawDefault === "false") {
      schema.default = rawDefault === "true";
    } else if (/^-?\d+(?:\.\d+)?$/.test(rawDefault)) {
      schema.default = Number(rawDefault);
    } else if (rawDefault) {
      schema.default = rawDefault;
    }
    params.push(
      buildParamDoc(
        name,
        descByName.get(name) ?? `JSON parameter ${name}.`,
        schema,
      ),
    );
  }
  return params;
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

  function sampleValueForParam(param) {
    const examples = Array.isArray(param.examples) ? param.examples : [];
    const example = examples.find(
      (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
    );
    if (example !== undefined) return example;

    const schema =
      param.schema && typeof param.schema === "object" ? param.schema : {};
    if (
      schema.default === null ||
      ["string", "number", "boolean"].includes(typeof schema.default)
    ) {
      return schema.default;
    }
    if (Array.isArray(schema.enum) && typeof schema.enum[0] === "string") {
      return schema.enum[0];
    }
    if (schema.type === "boolean") return false;
    if (schema.type === "number") return 1;
    return "example";
  }

  function buildExampleCallForAction(actionName, params) {
    if (!params || params.length === 0) {
      return [];
    }
    /** @type {Record<string, string | number | boolean | null>} */
    const sampleParams = {};
    for (const p of params) {
      sampleParams[p.name] = sampleValueForParam(p);
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
    const constants = extractConstLiterals(src);

    const objects = extractActionObjects(filePath, src);
    for (const obj of objects) {
      const name = extractResolvedStringProp(
        obj.objectText,
        "name",
        constants,
        src,
      );
      if (!name) continue;
      if (RETIRED_IMPLEMENTATION_ONLY_ACTIONS.has(name)) continue;
      if (coreActionNames.has(name)) continue;
      const description = expandDescriptionTemplateLiterals(
        extractTopLevelStringProp(obj.objectText, "description") ?? "",
        filePath,
      );
      const descriptionCompressed = extractTopLevelStringProp(
        obj.objectText,
        "descriptionCompressed",
      );
      const similes = extractTopLevelStringArrayProp(obj.objectText, "similes");
      const explicitParameters = sanitizeParameters(
        extractTopLevelLiteralProp(obj.objectText, "parameters", constants),
      );
      const descriptionParameters = inferParametersFromDescription(description);
      const jsonTemplateParameters =
        explicitParameters.length === 0 &&
        descriptionParameters.length === 0 &&
        (name.endsWith("") || description.toLowerCase().includes("router"))
          ? inferParametersFromJsonTemplate(src)
          : [];
      const parameters =
        explicitParameters.length > 0
          ? explicitParameters
          : descriptionParameters.length > 0
            ? descriptionParameters
            : jsonTemplateParameters.length > 0
              ? jsonTemplateParameters
              : inferParameters(obj.objectText);
      const exampleCalls = buildExampleCallForAction(name, parameters);

      // Do not overwrite existing entries; prefer the first seen (stable ordering).
      if (!actionDocsByName.has(name)) {
        actionDocsByName.set(name, {
          name,
          description,
          descriptionCompressed:
            typeof descriptionCompressed === "string"
              ? descriptionCompressed
              : undefined,
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
      if (a.descriptionCompressed) {
        out.descriptionCompressed = a.descriptionCompressed;
      }
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
