/**
 * Preserves complete Ollama / zerollama embedding inputs while honoring an
 * explicit operator-configured character ceiling as an all-or-nothing guard.
 */
import { toWellFormedUnicode } from "@elizaos/core";

export function validateEmbedInput(input: string | string[], maxChars: number): string | string[] {
  if (typeof input === "string") {
    const wellFormed = toWellFormedUnicode(input);
    if (wellFormed.length <= maxChars) return wellFormed;
    throw new RangeError(
      `Embedding input exceeds the provider-safe limit (${wellFormed.length}/${maxChars} chars)`
    );
  }
  return input.map((text) => {
    const wellFormed = toWellFormedUnicode(text);
    if (wellFormed.length <= maxChars) return wellFormed;
    throw new RangeError(
      `Embedding input exceeds the provider-safe limit (${wellFormed.length}/${maxChars} chars)`
    );
  });
}

/** Resolve only an explicit operator ceiling; otherwise preserve all input. */
export async function resolveEmbedMaxChars(options: {
  apiBase: string;
  model: string;
  fetchImpl?: typeof fetch;
  envMaxChars?: string | undefined;
}): Promise<number> {
  const envCap = Number(options.envMaxChars);
  if (Number.isFinite(envCap) && envCap > 0) {
    return Math.floor(envCap);
  }
  return Number.POSITIVE_INFINITY;
}
