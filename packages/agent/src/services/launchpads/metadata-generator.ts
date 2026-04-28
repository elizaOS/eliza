/**
 * LLM-driven token metadata generation.
 *
 * Returns a strict-typed metadata bundle the launchpad engine drops into
 * the launchpad form. The runtime's existing useModel surface handles
 * provider routing — same path the rest of the agent uses.
 */

import { type IAgentRuntime, ModelType, logger } from "@elizaos/core";

export interface GeneratedTokenMetadata {
  name: string;
  symbol: string;
  description: string;
  imagePrompt: string;
  theme: string;
}

const SYSTEM_PROMPT = `You generate metadata for a meme-coin launchpad submission.
Reply with strict JSON matching the schema:
{
  "name": string (1-32 chars, brandable),
  "symbol": string (3-6 uppercase letters/digits, no whitespace),
  "description": string (60-280 chars, single paragraph, marketing-friendly),
  "imagePrompt": string (one short sentence describing token art for an image generator),
  "theme": string (one-word or two-word theme for narration like 'cozy DeFi cat')
}
No prose, no fences, no extra fields.`;

interface MetadataHints {
  /** Optional theme hint from the user prompt (free-form). */
  theme?: string;
  /** Optional symbol seed if the user already has one. */
  symbolHint?: string;
}

function safeParse(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Tolerate fenced JSON in case the model wraps it.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clampSymbol(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
}

export async function generateTokenMetadata(
  runtime: IAgentRuntime,
  hints: MetadataHints = {},
): Promise<GeneratedTokenMetadata> {
  const userPrompt = [
    hints.theme ? `Theme hint: ${hints.theme}` : "",
    hints.symbolHint ? `Symbol hint: ${hints.symbolHint}` : "",
    "Generate metadata now.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: `${SYSTEM_PROMPT}\n\n${userPrompt}`,
  });

  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const parsed = safeParse(text);
  if (!parsed) {
    logger.warn(
      `[launchpad] Metadata model returned non-JSON; falling back to a placeholder.`,
    );
    return fallbackMetadata(hints);
  }

  const name =
    typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim().slice(0, 32)
      : null;
  const symbolRaw =
    typeof parsed.symbol === "string" ? clampSymbol(parsed.symbol) : "";
  const description =
    typeof parsed.description === "string"
      ? parsed.description.trim().slice(0, 280)
      : null;
  const imagePrompt =
    typeof parsed.imagePrompt === "string" && parsed.imagePrompt.trim()
      ? parsed.imagePrompt.trim()
      : null;
  const theme =
    typeof parsed.theme === "string" && parsed.theme.trim()
      ? parsed.theme.trim()
      : hints.theme || "meme";

  if (!name || !symbolRaw || !description || !imagePrompt) {
    logger.warn(
      `[launchpad] Metadata model omitted required fields; falling back.`,
    );
    return fallbackMetadata(hints);
  }

  return {
    name,
    symbol: symbolRaw,
    description,
    imagePrompt,
    theme,
  };
}

function fallbackMetadata(hints: MetadataHints): GeneratedTokenMetadata {
  const symbol = clampSymbol(hints.symbolHint || "WAGMI") || "WAGMI";
  const theme = hints.theme || "meme";
  return {
    name: `Eliza ${symbol}`,
    symbol,
    description:
      "An autonomously-launched meme token, deployed by an Eliza agent during a watch-mode browser session.",
    imagePrompt: `friendly meme coin mascot, vibrant colors, ${theme}`,
    theme,
  };
}
