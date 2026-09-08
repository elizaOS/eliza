/**
 * Forward request body pipeline. Mirrors processBody() in proxy.js v2.2.3
 * layer-by-layer, in the same order, with the same string operations, except
 * that `stripThinkingParameters` removes only the root object's own `thinking`
 * property (depth 1), brace-matches the parameter value, and skips
 * insignificant whitespace around the separator comma so removal never emits
 * malformed JSON regardless of key position or pretty-printing and never
 * corrupts a nested `thinking` field carried by tool inputs or tool schemas.
 * That is a deliberate correctness divergence, not drift to reconcile away.
 *
 * Layers (in processing order):
 *   2. String trigger sanitization       (sanitize.ts)
 *   3. Tool name renames                 (tool-rename.ts)
 *   6. Property name renames             (tool-rename.ts)
 *   4. System prompt template strip      (system-prompt.ts)
 *   5. Tool description strip + synthetic CC tools (cc-tool-injection.ts)
 *   1. Billing fingerprint injection     (billing-fingerprint.ts)
 *   metadata injection (device_id + session_id)
 *   8. Strip trailing assistant prefill
 *   9. Strip thinking blocks
 */

import { randomBytes, randomUUID } from "node:crypto";
import { buildBillingBlock } from "./billing-fingerprint.js";
import { processToolsSection } from "./cc-tool-injection.js";
import type { Pair } from "./sanitize.js";
import { applyReplacements } from "./sanitize.js";
import type { SystemPromptStripConfig } from "./system-prompt.js";
import { stripSystemConfig } from "./system-prompt.js";
import { applyQuotedRenames } from "./tool-rename.js";

export interface ProcessBodyConfig {
  replacements: ReadonlyArray<Pair>;
  toolRenames: ReadonlyArray<Pair>;
  propRenames: ReadonlyArray<Pair>;
  systemPromptStrip?: SystemPromptStripConfig;
  stripSystemConfig?: boolean;
  stripToolDescriptions?: boolean;
  injectCCSyntheticTools?: boolean;
  stripTrailingAssistantPrefill?: boolean;
  stripThinkingBlocks?: boolean;
  deviceId?: string;
  sessionId?: string;
}

// Generated once at module load — matches proxy.js's per-process identifiers.
const DEVICE_ID = randomBytes(32).toString("hex");
export const INSTANCE_SESSION_ID = randomUUID();

export interface ProcessBodyResult {
  body: string;
  stats: {
    systemConfigStripped: number;
    descriptionsStripped: number;
    syntheticToolsInjected: number;
    assistantPrefillStripped: number;
    thinkingBlocksStripped: number;
    thinkingParamsStripped: number;
  };
}

function stripThinkingParameters(value: string): {
  value: string;
  count: number;
} {
  const out: string[] = [];
  let cursor = 0; // start of the not-yet-emitted region
  let count = 0;
  // Structural nesting depth over `{`/`[`. The request body's root object is
  // depth 1, so Anthropic's own top-level `thinking` request parameter is the
  // only `"thinking"` key encountered at depth === 1. Keys nested inside
  // messages, tool inputs, or tool schemas sit at depth >= 2 and MUST survive
  // unchanged — stripping them silently corrupts replayed tool arguments that
  // legitimately carry a `thinking` field. See PR #29167 review.
  let depth = 0;
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === '"') {
      // Consume the whole string token so `{`/`}`/`,` inside it never move the
      // depth counter or masquerade as a separator.
      const stringStart = i;
      i += 1;
      while (i < value.length) {
        const cc = value[i];
        if (cc === "\\") {
          i += 2;
          continue;
        }
        if (cc === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      // A `"thinking"` string is the removable request parameter only when it
      // is a key of the root object (depth === 1) whose value is an object.
      if (depth === 1 && value.slice(stringStart, i) === '"thinking"') {
        let j = i;
        while (j < value.length && value[j]?.trim() === "") j += 1;
        if (value[j] === ":") {
          j += 1;
          while (j < value.length && value[j]?.trim() === "") j += 1;
          if (value[j] === "{") {
            // Brace-match the value (tracking string/escape state) so a nested
            // object or a `}` inside a string does not end the removal early
            // and leave orphaned syntax on the wire. `findMatchingObjectEnd`
            // returns the index just past the matching `}`.
            const objectEnd = findMatchingObjectEnd(value, j);
            if (objectEnd >= 0) {
              // Consume the leading comma when present; otherwise (first key of
              // the object) consume the trailing comma so removal never leaves
              // a dangling separator such as `{,"system":...}` that
              // api.anthropic.com rejects. Both scans skip insignificant
              // whitespace so pretty-printed bodies (where the char adjacent to
              // the key is a space or newline, not the comma) are handled the
              // same as minified ones.
              let leading = stringStart - 1;
              while (leading > cursor && value[leading]?.trim() === "") leading -= 1;
              const hasLeadingComma = leading >= cursor && value[leading] === ",";
              const removalStart = hasLeadingComma ? leading : stringStart;
              let removalEnd = objectEnd;
              if (!hasLeadingComma) {
                let trailing = removalEnd;
                while (trailing < value.length && value[trailing]?.trim() === "") {
                  trailing += 1;
                }
                if (value[trailing] === ",") removalEnd = trailing + 1;
              }
              out.push(value.slice(cursor, removalStart));
              cursor = removalEnd;
              count += 1;
              // Skip the removed span; its braces are balanced so depth is
              // unchanged.
              i = removalEnd;
            }
          }
        }
      }
      continue;
    }
    if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") depth -= 1;
    i += 1;
  }
  out.push(value.slice(cursor));
  return { value: out.join(""), count };
}

function insertTopLevelField(body: string, field: string): string {
  if (!body.startsWith("{")) return `{${field}}`;

  const rest = body.slice(1);
  const separator = rest.trimStart().startsWith("}") ? "" : ",";
  return `{${field}${separator}${rest}`;
}

function findMatchingObjectEnd(str: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function processBody(bodyStr: string, config: ProcessBodyConfig): ProcessBodyResult {
  let m = bodyStr;

  // Layer 2: String trigger sanitization
  m = applyReplacements(m, config.replacements);

  // Layer 3: Tool name fingerprint bypass
  m = applyQuotedRenames(m, config.toolRenames);

  // Layer 6: Property name renaming
  m = applyQuotedRenames(m, config.propRenames);

  // Layer 4: System prompt template bypass
  let systemConfigStripped = 0;
  if (config.stripSystemConfig !== false) {
    const r = stripSystemConfig(m, config.systemPromptStrip);
    m = r.body;
    systemConfigStripped = r.stripped;
  }

  // Layer 5: Tool description stripping + Layer 5b: synthetic CC tools
  const toolResult = processToolsSection(
    m,
    config.stripToolDescriptions !== false,
    config.injectCCSyntheticTools !== false
  );
  m = toolResult.body;

  // Layer 1: Billing header injection (dynamic fingerprint per request)
  const billingBlock = buildBillingBlock(m);
  const sysArrayIdx = m.indexOf('"system":[');
  if (sysArrayIdx !== -1) {
    const insertAt = sysArrayIdx + '"system":['.length;
    m = `${m.slice(0, insertAt)}${billingBlock},${m.slice(insertAt)}`;
  } else if (m.includes('"system":"')) {
    const sysStart = m.indexOf('"system":"');
    let i = sysStart + '"system":"'.length;
    while (i < m.length) {
      if (m[i] === "\\") {
        i += 2;
        continue;
      }
      if (m[i] === '"') break;
      i++;
    }
    const sysEnd = i + 1;
    const originalSysStr = m.slice(sysStart + '"system":'.length, sysEnd);
    m =
      m.slice(0, sysStart) +
      '"system":[' +
      billingBlock +
      ',{"type":"text","text":' +
      originalSysStr +
      "}]" +
      m.slice(sysEnd);
  } else {
    m = insertTopLevelField(m, `"system":[${billingBlock}]`);
  }

  // Metadata injection: device_id + session_id matching real CC format
  const deviceId = config.deviceId ?? DEVICE_ID;
  const sessionId = config.sessionId ?? INSTANCE_SESSION_ID;
  const metaValue = JSON.stringify({
    device_id: deviceId,
    session_id: sessionId,
  });
  const metaJson = `"metadata":{"user_id":${JSON.stringify(metaValue)}}`;
  const existingMeta = m.indexOf('"metadata":{');
  if (existingMeta !== -1) {
    let mi = existingMeta + '"metadata":'.length;
    mi = findMatchingObjectEnd(m, mi);
    if (mi !== -1) {
      m = m.slice(0, existingMeta) + metaJson + m.slice(mi);
    } else {
      m = insertTopLevelField(m, metaJson);
    }
  } else {
    m = insertTopLevelField(m, metaJson);
  }

  // Layer 8: Strip trailing assistant prefill
  let assistantPrefillStripped = 0;
  if (config.stripTrailingAssistantPrefill !== false) {
    const msgsIdx = m.indexOf('"messages":[');
    if (msgsIdx !== -1) {
      const arrayStart = msgsIdx + '"messages":['.length;
      const positions: { start: number; end: number }[] = [];
      let depth = 0;
      let inString = false;
      let objStart = -1;
      for (let i = arrayStart; i < m.length; i++) {
        const c = m[i];
        if (inString) {
          if (c === "\\") {
            i++;
            continue;
          }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') {
          inString = true;
          continue;
        }
        if (c === "{") {
          if (depth === 0) objStart = i;
          depth++;
        } else if (c === "}") {
          depth--;
          if (depth === 0 && objStart !== -1) {
            positions.push({ start: objStart, end: i });
            objStart = -1;
          }
        } else if (c === "]" && depth === 0) {
          break;
        }
      }
      while (positions.length > 0) {
        const last = positions[positions.length - 1];
        if (!last) break;
        const obj = m.slice(last.start, last.end + 1);
        if (!obj.includes('"role":"assistant"')) break;
        let stripFrom = last.start;
        for (let i = last.start - 1; i >= arrayStart; i--) {
          if (m[i] === ",") {
            stripFrom = i;
            break;
          }
          if (m[i] !== " " && m[i] !== "\n" && m[i] !== "\r" && m[i] !== "\t") break;
        }
        m = m.slice(0, stripFrom) + m.slice(last.end + 1);
        positions.pop();
        assistantPrefillStripped++;
      }
    }
  }

  // Layer 9: Strip thinking blocks
  let thinkingBlocksStripped = 0;
  let thinkingParamsStripped = 0;
  if (config.stripThinkingBlocks !== false) {
    const strippedThinkingParameters = stripThinkingParameters(m);
    m = strippedThinkingParameters.value;
    thinkingParamsStripped = strippedThinkingParameters.count;
    const msgsIdx2 = m.indexOf('"messages":[');
    if (msgsIdx2 !== -1) {
      for (const marker of ['{"type":"thinking"', '{"type":"redacted_thinking"']) {
        let searchFrom = msgsIdx2;
        while (true) {
          const idx = m.indexOf(marker, searchFrom);
          if (idx === -1) break;
          let depth = 0;
          let inStr = false;
          let end = -1;
          for (let i = idx; i < m.length; i++) {
            const c = m[i];
            if (inStr) {
              if (c === "\\") {
                i++;
                continue;
              }
              if (c === '"') inStr = false;
              continue;
            }
            if (c === '"') {
              inStr = true;
              continue;
            }
            if (c === "{") depth++;
            else if (c === "}") {
              depth--;
              if (depth === 0) {
                end = i;
                break;
              }
            }
          }
          if (end === -1) break;
          let stripStart = idx;
          let stripEnd = end + 1;
          if (m[stripEnd] === ",") stripEnd++;
          else if (m[stripStart - 1] === ",") stripStart--;
          m = m.slice(0, stripStart) + m.slice(stripEnd);
          thinkingBlocksStripped++;
          searchFrom = stripStart;
        }
      }
    }
  }

  return {
    body: m,
    stats: {
      systemConfigStripped,
      descriptionsStripped: toolResult.descriptionsStripped,
      syntheticToolsInjected: toolResult.syntheticToolsInjected,
      assistantPrefillStripped,
      thinkingBlocksStripped,
      thinkingParamsStripped,
    },
  };
}
