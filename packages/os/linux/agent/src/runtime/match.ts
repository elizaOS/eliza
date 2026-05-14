// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Similes-based action matching.
 *
 * elizaOS Actions ship with a `similes` field — short natural-language phrases
 * that describe when the action should fire ("connect to wifi",
 * "join network"). On models large enough to follow elizaOS's planner prompt,
 * the LLM ranks similes and picks. On a 1B model that can't, we do the ranking
 * deterministically: tokenize the message + each simile, score by overlap +
 * verb-prefix bonus, return the winner above a threshold.
 *
 * This replaces the per-action regex front-end (`agent/src/intent.ts`). The
 * Action's `similes` ARE the matching surface — no second source of truth.
 *
 * The algorithm:
 *   1. Lowercase, strip punctuation, tokenize on whitespace.
 *   2. For each simile, compute Jaccard overlap of token sets with the message.
 *   3. Boost when the simile's first word matches the message's first word
 *      (verb-leading match — "build" vs "build" beats "make" vs "build").
 *   4. Boost when the message contains the simile as a substring.
 *   5. Best action above MATCH_THRESHOLD wins; otherwise return null.
 *
 * Slot extraction (for "build me a calendar" → slug="calendar") happens in
 * each action's handler via `extractSlot`, not here — keeps matching pure.
 */

const PUNCTUATION_RE = /[.,!?;:'"()[\]{}]/g;
const WHITESPACE_RE = /\s+/;

// English fillers that score-pad simile overlap without contributing meaning.
// Filtering them prevents "what is 2+2" from matching "what is my ip" on a
// single shared `is` token. Kept short and idiomatic — pure functional words
// only; "list" / "open" / "build" stay because they're action verbs.
const STOP_WORDS = new Set([
    "a", "an", "the", "my", "your", "our", "this", "that", "these", "those",
    "i", "me", "we", "us", "you", "to", "of", "in", "on", "at", "with", "for",
    "and", "or", "but", "is", "am", "are", "was", "were", "be", "been",
    "do", "does", "did", "can", "could", "would", "should", "will", "shall",
    "please", "can", "could", "would", "may", "might",
    "have", "has", "had", "it", "its", "if", "then", "so", "just",
]);

export interface MatchResult<T> {
    action: T;
    score: number;
    simile: string;
}

export interface Matchable {
    /** Display name (used for tie-breaking / logs). */
    name: string;
    /** Natural-language triggers — the matching surface. */
    similes?: string[];
    /** Higher priority wins ties. Default 0. */
    priority?: number;
}

const MATCH_THRESHOLD = 0.55;

// Wh-words don't deserve the verb-leading bonus the way action verbs do.
// "what is 2+2" starting with "what" should not score higher against "what
// can you do" just because both start with "what" — wh-words are too common
// across question forms. Action verbs ("build", "open", "list", "connect")
// are reliable intent signals; wh-words are not.
const WH_WORDS = new Set(["what", "how", "where", "when", "why", "who", "which"]);

export function normalize(input: string): string[] {
    return input
        .toLowerCase()
        .replace(PUNCTUATION_RE, " ")
        .trim()
        .split(WHITESPACE_RE)
        .filter((t) => t.length > 0);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) {
        if (b.has(token)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return intersection / union;
}

function content(tokens: string[]): string[] {
    return tokens.filter((t) => !STOP_WORDS.has(t));
}

function scoreSimile(messageTokens: string[], simile: string): number {
    const similesTokens = normalize(simile);
    if (similesTokens.length === 0) return 0;

    // Score on CONTENT tokens (stop-words filtered) — "what is" vs "what is"
    // overlap on a literal `is` shouldn't outweigh whether the meaningful
    // tokens align. Empty content sets fall back to full-token jaccard so
    // a help simile like "help" still matches itself.
    const msgContent = content(messageTokens);
    const simContent = content(similesTokens);

    const msgSet = new Set(msgContent.length > 0 ? msgContent : messageTokens);
    const simSet = new Set(simContent.length > 0 ? simContent : similesTokens);
    let score = jaccard(msgSet, simSet);

    // Require at least ONE shared content token. Without this gate, a
    // simile of pure stop-words (or a message of pure stop-words) can hit
    // threshold via verb-prefix + substring bonus alone.
    let sharedContent = 0;
    for (const t of msgSet) if (simSet.has(t)) sharedContent++;
    if (sharedContent === 0) return 0;

    // Verb-leading bonus: if the message starts with the simile's first
    // token, that's a strong signal ("connect to wifi X" vs simile "connect
    // to wifi"). Boost rather than gate because users say "please connect..."
    // / "can you connect..." which would otherwise miss. Wh-words ("what",
    // "how", ...) don't earn this bonus — they appear across every question
    // form and would otherwise pull arbitrary chat into the HELP simile.
    if (
        messageTokens[0] === similesTokens[0] &&
        messageTokens[0] !== undefined &&
        !WH_WORDS.has(messageTokens[0])
    ) {
        score += 0.25;
    }

    // Substring bonus: simile literally embedded in the message.
    const messageStr = messageTokens.join(" ");
    const similesStr = similesTokens.join(" ");
    if (messageStr.includes(similesStr)) score += 0.2;

    return Math.min(score, 1.0);
}

export function matchAction<T extends Matchable>(
    message: string,
    actions: readonly T[],
): MatchResult<T> | null {
    const messageTokens = normalize(message);
    if (messageTokens.length === 0) return null;

    let best: MatchResult<T> | null = null;
    for (const action of actions) {
        const similes = action.similes;
        if (similes === undefined) continue;
        for (const simile of similes) {
            const score = scoreSimile(messageTokens, simile);
            if (score < MATCH_THRESHOLD) continue;

            const effectiveScore = score + (action.priority ?? 0) * 0.001;
            if (best === null || effectiveScore > best.score) {
                best = { action, score: effectiveScore, simile };
            }
        }
    }
    return best;
}

/**
 * Extract a verb-trailing slot from a message.
 *
 *   "build me a calendar app"   verbs=[build,make,create]  → "calendar"
 *   "open my notes"             verbs=[open,launch,show]   → "notes"
 *
 * Strips leading verb, optional `me`, optional article, optional `the`/`my`;
 * strips trailing `app`/`application`/punctuation. Returns null if the
 * remainder is empty or whitespace.
 */
export function extractSlot(message: string, verbs: readonly string[]): string | null {
    const tokens = normalize(message);
    if (tokens.length < 2) return null;
    const first = tokens[0];
    if (first === undefined || !verbs.includes(first)) return null;

    let i = 1;
    if (tokens[i] === "me") i++;
    // Article — longest first so "an" beats "a".
    const article = tokens[i];
    if (article === "an" || article === "a" || article === "my" || article === "the") {
        i++;
    }

    let slotTokens = tokens.slice(i);
    while (slotTokens.length > 0) {
        const last = slotTokens[slotTokens.length - 1];
        if (last === "app" || last === "application") {
            slotTokens = slotTokens.slice(0, -1);
            continue;
        }
        break;
    }
    if (slotTokens.length === 0) return null;
    return slotTokens.join(" ").trim();
}

export function slugify(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
