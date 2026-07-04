/**
 * Layer 5: Tool description stripping + Layer 5b: synthetic Claude Code tool
 * injection for fingerprint compatibility.
 *
 * String-aware bracket matching (skips [ and ] inside JSON string values) so
 * description text can't corrupt depth.
 */

import { CC_SYNTHETIC_TOOLS } from "./constants.js";

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
  const toolsIdx = m.indexOf('"tools":[');
  if (toolsIdx === -1) {
    return { body: m, descriptionsStripped: 0, syntheticToolsInjected: 0 };
  }

  if (stripDescriptions) {
    const toolsEndIdx = findMatchingBracket(m, toolsIdx + '"tools":'.length);
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
      const insertAt = '"tools":['.length;
      section =
        section.slice(0, insertAt) + CC_SYNTHETIC_TOOLS.join(",") + "," + section.slice(insertAt);
      syntheticToolsInjected = CC_SYNTHETIC_TOOLS.length;
    }
    return {
      body: m.slice(0, toolsIdx) + section + m.slice(toolsEndIdx + 1),
      descriptionsStripped: stripped,
      syntheticToolsInjected,
    };
  }

  if (injectSyntheticTools) {
    const insertAt = toolsIdx + '"tools":['.length;
    return {
      body: m.slice(0, insertAt) + CC_SYNTHETIC_TOOLS.join(",") + "," + m.slice(insertAt),
      descriptionsStripped: 0,
      syntheticToolsInjected: CC_SYNTHETIC_TOOLS.length,
    };
  }

  return { body: m, descriptionsStripped: 0, syntheticToolsInjected: 0 };
}
