/**
 * Single model-phrasing seam for every user-visible line the orchestrator
 * composes itself (acks, confirmations, warnings, denials). Callers hand over
 * STRUCTURED FACTS plus a factual fallback string; ONE bounded TEXT_SMALL call
 * phrases them in the configured character's own voice, and any failure —
 * timeout, throw, empty output, or a post-validation violation — degrades to
 * the caller's fallback. The module owns the one prompt builder (extracted
 * from the spawn-ack generator so ack and confirmation voice cannot drift),
 * the banned internal-mechanism vocabulary, and the exact-substring
 * `mustInclude` receipt contract that keeps hashes/URLs riding verbatim.
 *
 * Machine-readable payloads (widgets, commit hashes, PR URLs) must never pass
 * through the model: append them with `withMachineAppendix`, which bypasses
 * phrasing entirely. Sends that carry already-phrased text spread
 * `AGENT_VOICED_METADATA` so the core transport voice gate does not re-phrase.
 */

import { type Character, type IAgentRuntime, ModelType } from "@elizaos/core";

export type PhraseIntent =
  | "confirm"
  | "refuse"
  | "fail"
  | "warn"
  | "notify"
  | "ask";

export interface PhraseFacts {
  intent: PhraseIntent;
  facts: Record<string, string | number | boolean | string[] | undefined>;
  /** Values that must appear in the output as exact, case-sensitive
   * substrings (labels, issue numbers, paths). A miss falls back. */
  mustInclude?: string[];
  /** Claims the model is explicitly forbidden to make. */
  mustNotClaim?: string[];
}

export interface PhraseOptions {
  /** Model race budget in ms. Default 1200, env
   * `ELIZA_ORCHESTRATOR_PHRASE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Longest accepted output; anything longer falls back. Default 320. */
  maxChars?: number;
  /** Small LRU memo key for repeating frames (cap warnings, first-post) so a
   * recurring identical frame does not re-bill a model call. */
  cacheKey?: string;
}

/** Spread into send metadata so the core transport voice gate skips
 * re-phrasing text this module already phrased. */
export const AGENT_VOICED_METADATA: { agentVoiced: true } = {
  agentVoiced: true,
};

/** Append a machine payload (widget block, commit hash, PR URL) below the
 * prose. The appendix bypasses the model entirely and must ride byte-identical
 * so downstream receipt/widget parsers keep binding. */
export function withMachineAppendix(prose: string, appendix: string): string {
  return `${prose}\n\n${appendix}`;
}

/** Internal-mechanism vocabulary that must never reach chat. Any hit in the
 * model output falls back to the caller's factual string. */
export const BANNED_MECHANISM_VOCAB_RE =
  /\b(?:sessions?|acp|receipts?|callbacks?|uuids?|orchestrators?|planners?)\b/i;

// 3.5s: at 1.2s the Cerebras round-trip lost the race often enough that the
// canned fallbacks ("Created task agent.") leaked to normies as the COMMON
// case (owner report 2026-08-19). Acks precede work measured in tens of
// seconds; a few hundred extra ms of voice is the right trade.
const DEFAULT_TIMEOUT_MS = 3_500;
const DEFAULT_MAX_CHARS = 320;
const FACT_VALUE_MAX_CHARS = 400;
const CACHE_CAP = 32;

/** Module-level LRU memo of successfully phrased frames, keyed by
 * agentId + cacheKey (fallbacks are never cached so a transient model outage
 * cannot pin the degraded string). */
const phrasedCache = new Map<string, string>();

const INTENT_FRAMES: Record<PhraseIntent, string> = {
  confirm:
    "You just did (or kicked off) something the user asked for. Confirm it plainly.",
  refuse:
    "You are declining to do what was asked. Say so plainly, and why, without apologizing at length.",
  fail: "Something the user asked for did not work. Report the failure honestly — no excuses, no technical jargon.",
  warn: "Warn the user about the situation the facts describe, so they can act on it.",
  notify: "Give the user a brief factual status update.",
  ask: "You need something from the user. Ask for it directly.",
};

/**
 * The character-voice slice of the prompt — extracted verbatim from the spawn
 * ack generator's system prompt so every phrased line (ack or confirmation)
 * derives its voice from the SAME composition: name, up to three bio lines,
 * up to eight deduped adjective/style traits. Pure + exported for tests.
 */
export function characterVoiceSlice(character: Character): string {
  const name = (character.name ?? "").trim() || "the assistant";
  const voiceParts: string[] = [];
  const bio = (character.bio ?? []).map((b) => b.trim()).filter(Boolean);
  if (bio.length > 0) voiceParts.push(bio.slice(0, 3).join(" "));
  const traits = [
    ...(character.adjectives ?? []),
    ...(character.style?.chat ?? []),
    ...(character.style?.all ?? []),
  ]
    .map((t) => t.trim())
    .filter(Boolean);
  if (traits.length > 0) {
    voiceParts.push(`Voice: ${[...new Set(traits)].slice(0, 8).join(", ")}.`);
  }
  return [`You are ${name}.`, voiceParts.join(" ").trim()]
    .filter((part) => part.length > 0)
    .join(" ");
}

function clipFactValue(value: string): string {
  return value.length > FACT_VALUE_MAX_CHARS
    ? `${value.slice(0, FACT_VALUE_MAX_CHARS - 1)}…`
    : value;
}

function factLines(facts: PhraseFacts["facts"]): string[] {
  return Object.entries(facts)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const rendered = Array.isArray(value)
        ? value.map((item) => clipFactValue(String(item))).join(", ")
        : clipFactValue(String(value));
      return `- ${key}: ${rendered}`;
    });
}

/**
 * The ONE prompt this module ever sends: character voice slice + intent frame
 * + compact fact list + exact-inclusion quotes + forbidden claims + standing
 * rules. Pure + deterministic so it is unit-tested directly.
 */
export function buildPhrasePrompt(
  character: Character,
  req: PhraseFacts,
  maxChars: number,
): string {
  const lines: string[] = [
    characterVoiceSlice(character),
    INTENT_FRAMES[req.intent],
    "Write ONE short message to the user, in your own voice, based ONLY on these facts:",
    ...factLines(req.facts),
  ];
  if (req.mustInclude && req.mustInclude.length > 0) {
    lines.push(
      "Include each of the following EXACTLY as written, character for character:",
      ...req.mustInclude.map((value) => `- include exactly: "${value}"`),
    );
  }
  if (req.mustNotClaim && req.mustNotClaim.length > 0) {
    lines.push(
      "Hard constraints — you must NOT claim any of the following:",
      ...req.mustNotClaim.map((claim) => `- do not claim: ${claim}`),
    );
  }
  lines.push(
    "Standing rules:",
    "- One short message only. Sentence case — not all-lowercase, not a headline.",
    "- Write in the same language the user's own words in the facts are written in.",
    "- Plain conversational text: no surrounding quotes, no markdown headers, no emoji, no preamble.",
    "- Never mention internal machinery: no sessions, receipts, callbacks, ids, or agent plumbing.",
    `- Keep it under ${maxChars} characters.`,
    "Your message:",
  );
  return lines.filter((line) => line.length > 0).join("\n");
}

function phraseTimeoutMs(runtime: IAgentRuntime, opts?: PhraseOptions): number {
  if (opts?.timeoutMs !== undefined && opts.timeoutMs > 0) {
    return opts.timeoutMs;
  }
  const raw =
    (typeof runtime.getSetting === "function"
      ? (runtime.getSetting("ELIZA_ORCHESTRATOR_PHRASE_TIMEOUT_MS") as
          | string
          | undefined)
      : undefined) ?? process.env.ELIZA_ORCHESTRATOR_PHRASE_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Strip a single pair of surrounding quotes and collapse outer whitespace —
 * the only sanitation applied before validation. */
function tidyModelOutput(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["`", "`"],
  ];
  for (const [open, close] of quotePairs) {
    if (
      text.length >= open.length + close.length &&
      text.startsWith(open) &&
      text.endsWith(close)
    ) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  return text;
}

/** Post-validation: the phrased text is only accepted when every mustInclude
 * value appears as an exact case-sensitive substring (hashes/URLs), the
 * banned-mechanism vocabulary is absent, and the length fits. */
export function validatePhrasedText(
  text: string,
  req: PhraseFacts,
  maxChars: number,
): boolean {
  if (!text) return false;
  if (text.length > maxChars) return false;
  if (BANNED_MECHANISM_VOCAB_RE.test(text)) return false;
  for (const value of req.mustInclude ?? []) {
    if (!text.includes(value)) return false;
  }
  return true;
}

/**
 * Phrase structured facts as one user-visible message in the agent's voice.
 * Single TEXT_SMALL call raced against the timeout; on ANY failure (error,
 * timeout, empty, validation miss) returns the caller's fallback with
 * `phrased: false`. Never throws, never retries, never makes a second model
 * call. Fallback strings are the caller's responsibility and must already
 * contain every mustInclude value — they are facts, not prose theater.
 */
export async function phraseForUser(
  runtime: IAgentRuntime,
  req: PhraseFacts,
  fallback: string,
  opts?: PhraseOptions,
): Promise<{ text: string; phrased: boolean }> {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const cacheKey = opts?.cacheKey
    ? `${String(runtime.agentId ?? "")}:${opts.cacheKey}`
    : undefined;
  try {
    if (cacheKey) {
      const hit = phrasedCache.get(cacheKey);
      if (hit !== undefined) {
        // LRU touch: re-insert as newest.
        phrasedCache.delete(cacheKey);
        phrasedCache.set(cacheKey, hit);
        return { text: hit, phrased: true };
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), phraseTimeoutMs(runtime, opts));
      (timer as { unref?: () => void }).unref?.();
    });
    // error-policy:J4 the phrased line is cosmetic voice over caller-owned
    // facts; model rejection/timeout degrades to the factual fallback string,
    // never fabricated data.
    let callError: string | undefined;
    const raw = await Promise.race([
      Promise.resolve(
        runtime.useModel(ModelType.TEXT_SMALL, {
          system: buildPhrasePrompt(runtime.character, req, maxChars),
          prompt: "Write the message now.",
          maxTokens: 128,
          temperature: 0.7,
          // Formatting call: suppress hidden reasoning. A reasoning-effort pin
          // (e.g. ELIZAOS_CLOUD_REASONING_EFFORT=high) burns the whole
          // 128-token cap on hidden reasoning and returns EMPTY content on
          // gemma-4-31b — every ack shipped the canned fallback for two days
          // (live 2026-08-20). thinking:"off" maps to the model's suppression
          // value in both the cloud and direct-Cerebras handlers.
          providerOptions: { eliza: { thinking: "off" } },
        }),
      ).catch((err) => {
        callError = err instanceof Error ? err.message : String(err);
        return null;
      }),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const text = typeof raw === "string" ? tidyModelOutput(raw) : "";
    if (!validatePhrasedText(text, req, maxChars)) {
      // WARN, not debug: the canned fallbacks kept reaching users while this
      // deployment drops plugin debug logs entirely — the cause (timeout vs
      // model error vs rejected output) was invisible for two days
      // (2026-08-20). The error text is load-bearing diagnosis.
      runtime.logger?.warn?.(
        {
          reason:
            raw === null
              ? callError
                ? "model-error"
                : "timeout"
              : "validation-reject",
          ...(callError ? { error: callError } : {}),
          raw: typeof raw === "string" ? raw : String(raw),
          rejected: text,
          intent: req.intent,
        },
        "[phrase-for-user] fell back to canned text",
      );
      return { text: fallback, phrased: false };
    }
    if (cacheKey) {
      phrasedCache.set(cacheKey, text);
      while (phrasedCache.size > CACHE_CAP) {
        const oldest = phrasedCache.keys().next().value;
        if (oldest === undefined) break;
        phrasedCache.delete(oldest);
      }
    }
    return { text, phrased: true };
  } catch {
    // error-policy:J4 phrasing must never take the turn down; degrade to the
    // caller's factual fallback.
    return { text: fallback, phrased: false };
  }
}
