export function stripThinkBlocks(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  return withoutBlocks.replace(/<\/?think>/gi, "").trim();
}

function unwrapCodeFence(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fencedMatch?.[1]?.trim() || text;
}

/**
 * Extract the first balanced JSON object from an arbitrary model response.
 * This is more reliable than a greedy regex when models emit thinking tags,
 * code fences, or multiple brace-delimited regions.
 */
export function extractFirstJsonObject(response: string): string | null {
  const cleaned = unwrapCodeFence(stripThinkBlocks(response)).trim();

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < cleaned.length; index++) {
    const character = cleaned[index];
    if (!character) {
      continue;
    }

    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, index + 1);
      }
    }
  }

  return null;
}
