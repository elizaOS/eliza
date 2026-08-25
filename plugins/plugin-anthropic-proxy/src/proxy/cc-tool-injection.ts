/**
 * Layer 5: Tool description stripping + Layer 5b: synthetic Claude Code tool
 * injection for fingerprint compatibility.
 *
 * String-aware bracket matching (skips [ and ] inside JSON string values) so
 * description text can't corrupt depth.
 */

import { CC_SYNTHETIC_TOOLS } from "./constants.js";

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function findMatchingBracket(str: string, start: number): number {
  let d = 0;
  let inStr = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
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
    if (c === "[") {
      d++;
    } else if (c === "]") {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/**
 * Locates the top-level `"tools"` key without mistaking the same text inside
 * string values (which appear as `\"tools\":` once escaped) for the real key.
 * The first occurrence wins, so canonical bodies behave exactly as before,
 * while keys written with non-canonical whitespace (`"tools" : [`) are still
 * discovered instead of silently passing through unmodified.
 */
function findToolsKey(str: string): number {
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && str.startsWith('"tools"', i)) {
      let j = i + '"tools"'.length;
      while (j < str.length && isWhitespace(str[j])) j++;
      if (str[j] !== ":") {
        inStr = true;
        continue;
      }
      j++;
      while (j < str.length && isWhitespace(str[j])) j++;
      if (str[j] === "[") return i;
      inStr = true;
      continue;
    }
    if (c === '"') {
      inStr = true;
    }
  }
  return -1;
}

/**
 * Returns the index of the `[` that opens the tools array for a key already
 * located by findToolsKey, tolerating whitespace around the colon.
 */
function findToolsArrayOpen(str: string, keyIdx: number): number {
  let j = keyIdx + '"tools"'.length;
  while (j < str.length && isWhitespace(str[j])) j++;
  if (str[j] !== ":") return -1;
  j++;
  while (j < str.length && isWhitespace(str[j])) j++;
  return str[j] === "[" ? j : -1;
}

export interface ToolSectionResult {
  body: string;
  descriptionsStripped: number;
  syntheticToolsInjected: number;
}

export function processToolsSection(
  m: string,
  stripDescriptions: boolean,
  injectSyntheticTools: boolean
): ToolSectionResult {
  const toolsIdx = findToolsKey(m);
  if (toolsIdx === -1) {
    return { body: m, descriptionsStripped: 0, syntheticToolsInjected: 0 };
  }
  const toolsOpenIdx = findToolsArrayOpen(m, toolsIdx);
  if (toolsOpenIdx === -1) {
    return { body: m, descriptionsStripped: 0, syntheticToolsInjected: 0 };
  }

  if (stripDescriptions) {
    const toolsEndIdx = findMatchingBracket(m, toolsOpenIdx);
    if (toolsEndIdx === -1) {
      return { body: m, descriptionsStripped: 0, syntheticToolsInjected: 0 };
    }
    let section = m.slice(toolsIdx, toolsEndIdx + 1);
    let from = 0;
    let stripped = 0;
    while (true) {
      const d = section.indexOf('"description":"', from);
      if (d === -1) break;
      const vs = d + '"description":"'.length;
      let i = vs;
      while (i < section.length) {
        if (section[i] === "\\" && i + 1 < section.length) {
          i += 2;
          continue;
        }
        if (section[i] === '"') break;
        i++;
      }
      section = section.slice(0, vs) + section.slice(i);
      from = vs + 1;
      stripped++;
    }
    let syntheticToolsInjected = 0;
    if (injectSyntheticTools) {
      const insertAt = toolsOpenIdx - toolsIdx + 1;
      const syntheticTools = CC_SYNTHETIC_TOOLS.join(",");
      section = `${section.slice(0, insertAt)}${syntheticTools},${section.slice(insertAt)}`;
      syntheticToolsInjected = CC_SYNTHETIC_TOOLS.length;
    }
    return {
      body: m.slice(0, toolsIdx) + section + m.slice(toolsEndIdx + 1),
      descriptionsStripped: stripped,
      syntheticToolsInjected,
    };
  }

  if (injectSyntheticTools) {
    const insertAt = toolsOpenIdx + 1;
    const syntheticTools = CC_SYNTHETIC_TOOLS.join(",");
    return {
      body: `${m.slice(0, insertAt)}${syntheticTools},${m.slice(insertAt)}`,
      descriptionsStripped: 0,
      syntheticToolsInjected: CC_SYNTHETIC_TOOLS.length,
    };
  }

  return { body: m, descriptionsStripped: 0, syntheticToolsInjected: 0 };
}
