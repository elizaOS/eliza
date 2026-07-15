/**
 * Shortcut registry + matcher (#8791).
 *
 * `ShortcutRegistry` is a per-agent store of `ShortcutDefinition`s (mirroring
 * the per-agentId pattern of the slash-command registry). `matchShortcut` is a
 * pure, tiered matcher:
 *
 *   1. Explicit tier — slash/`!` aliases, exact/prefix. Unambiguous, confidence 1.
 *   2. Natural tier  — anchored regex / slot-template patterns over normalized
 *      text (ASR-tolerant), with a confidence floor and ambiguity refusal.
 *
 * Explicit always wins. Natural matches that tie within an epsilon are refused
 * (return null) so the turn falls through to the LLM instead of guessing.
 */

import type {
	ShortcutDefinition,
	ShortcutMatch,
	ShortcutMatchContext,
	ShortcutPattern,
} from "../types/shortcut";

/** Natural-language matches below this confidence never short-circuit. */
export const SHORTCUT_CONFIDENCE_FLOOR = 0.6;
/** Two natural matches within this confidence gap are "ambiguous" → defer to LLM. */
export const SHORTCUT_AMBIGUITY_EPSILON = 0.1;

/** Leading fillers/wake words stripped before natural-language matching. */
const LEADING_FILLER =
	/^(?:hey|ok|okay|yo|um|uh|please|pls|could you|can you|would you|will you|i want to|i'd like to|i would like to|let's|lets)\s+/i;

/**
 * Normalize text for natural-language matching: lowercase, strip surrounding
 * whitespace, drop leading wake/filler words and a trailing "please", remove
 * punctuation an ASR transcript wouldn't reliably produce, and collapse runs of
 * whitespace. Slash/`!` prefixes are NOT normalized away (explicit matching uses
 * the raw text).
 */
export function normalizeForMatch(text: string): string {
	let s = text.trim().toLowerCase();
	// strip one layer of leading filler / wake words, repeatedly
	let prev: string;
	do {
		prev = s;
		s = s.replace(LEADING_FILLER, "");
	} while (s !== prev);
	s = s.replace(/\s+please[.!?]*$/i, "");
	// drop punctuation ASR omits; keep letters, digits, whitespace
	s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

/**
 * Compile a slot template like `"open {section}"` to an anchored regex with
 * named capture groups. Slots capture whole words (joined by single spaces) and
 * never include the separating whitespace, so `"open settings"` → `section:
 * "settings"` and `"set thinking to high"` → `field: "thinking"`, `level: "high"`.
 */
export function compileTemplate(template: string): RegExp {
	const tokens = template
		.trim()
		.split(/(\{[a-zA-Z_][a-zA-Z0-9_]*\})/g)
		.filter((token) => token !== "");
	const slotCount = tokens.filter((token) => /^\{.+\}$/.test(token)).length;
	let seen = 0;
	let pattern = "";
	const needsSeparator = () => pattern !== "" && !pattern.endsWith("\\s+");
	for (const token of tokens) {
		const slot = token.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
		if (slot) {
			seen += 1;
			if (needsSeparator()) pattern += "\\s+";
			// Final slot is greedy (captures the rest); earlier slots are lazy so a
			// trailing literal still gets to match.
			const inner = seen === slotCount ? "*" : "*?";
			pattern += `(?<${slot[1]}>[\\p{L}\\p{N}]+(?:\\s+[\\p{L}\\p{N}]+)${inner})`;
		} else {
			const leadingWs = /^\s/.test(token);
			const trailingWs = /\s$/.test(token);
			const core = token
				.trim()
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(/\s+/g, "\\s+");
			if (!core) continue;
			if (leadingWs && needsSeparator()) pattern += "\\s+";
			pattern += core;
			if (trailingWs) pattern += "\\s+";
		}
	}
	return new RegExp(`^${pattern}$`, "iu");
}

function patternRegex(pattern: ShortcutPattern): RegExp | null {
	if (pattern.regex) return pattern.regex;
	if (pattern.template) return compileTemplate(pattern.template);
	return null;
}

/** A single leading Discord user mention and its separator. */
const LEADING_RAW_MENTION = /^<@!?\d+>\s*/;

/**
 * Expose the command behind a connector-native mention to the deterministic
 * shortcut gate. Inner mentions remain arguments.
 */
export function stripLeadingMentionForShortcut(text: string): string {
	return text.replace(LEADING_RAW_MENTION, "");
}

function aliasMatches(raw: string, alias: string): boolean {
	const a = alias.toLowerCase();
	if (raw === a) return true;
	if (raw.startsWith(a)) {
		const rest = raw.slice(a.length);
		return /^[\s:]/.test(rest);
	}
	return false;
}

function requiredAction(def: ShortcutDefinition): string | undefined {
	if (def.requiresAction) return def.requiresAction;
	if (def.target.kind === "action") return def.target.name;
	return undefined;
}

function passesGates(
	def: ShortcutDefinition,
	context: ShortcutMatchContext,
): boolean {
	if (def.requiresAuth && !context.isAuthorized) return false;
	if (def.requiresElevated && !context.isElevated) return false;
	if (def.requiresContext && def.requiresContext.length > 0) {
		if (!context.view || !def.requiresContext.includes(context.view)) {
			return false;
		}
	}
	const action = requiredAction(def);
	if (action && context.actions && !context.actions.includes(action)) {
		return false;
	}
	return true;
}

/**
 * Match `text` against `definitions`. Returns the resolved shortcut + extracted
 * slots + confidence, or `null` when nothing matches confidently/unambiguously.
 */
export function matchShortcut(
	definitions: readonly ShortcutDefinition[],
	text: string,
	context: ShortcutMatchContext = {},
): ShortcutMatch | null {
	// The natural tier already dissolves mentions during normalization; only the
	// exact explicit tier needs this connector-wire normalization.
	const raw = stripLeadingMentionForShortcut(text.trim()).trim().toLowerCase();
	if (!raw) return null;

	// ── Tier 1: explicit (slash/`!`) — unambiguous, always eligible ──────────
	const explicit: ShortcutMatch[] = [];
	for (const def of definitions) {
		if (def.kind !== "explicit" || !def.aliases) continue;
		if (!passesGates(def, context)) continue;
		if (def.aliases.some((alias) => aliasMatches(raw, alias))) {
			explicit.push({ shortcut: def, parameters: {}, confidence: 1 });
		}
	}
	if (explicit.length > 0) {
		explicit.sort(
			(a, b) => (b.shortcut.priority ?? 0) - (a.shortcut.priority ?? 0),
		);
		return explicit[0] ?? null;
	}

	// ── Tier 2: natural language — caller-enabled, confidence-floored ────────
	if (!context.allowNatural) return null;
	const normalized = normalizeForMatch(text);
	if (!normalized) return null;

	const natural: ShortcutMatch[] = [];
	for (const def of definitions) {
		if (def.kind !== "natural" || !def.patterns) continue;
		if (!passesGates(def, context)) continue;
		const base = def.confidence ?? 0.9;
		for (const pattern of def.patterns) {
			const regex = patternRegex(pattern);
			if (!regex) continue;
			const m = normalized.match(regex);
			if (!m) continue;
			const parameters: Record<string, string> = {};
			for (const [name, value] of Object.entries(m.groups ?? {})) {
				if (value) parameters[name] = value.trim();
			}
			natural.push({
				shortcut: def,
				parameters,
				confidence: pattern.confidence ?? base,
			});
			break; // first matching pattern per definition
		}
	}

	const eligible = natural
		.filter((match) => match.confidence >= SHORTCUT_CONFIDENCE_FLOOR)
		.sort((a, b) => {
			if (b.confidence !== a.confidence) return b.confidence - a.confidence;
			return (b.shortcut.priority ?? 0) - (a.shortcut.priority ?? 0);
		});
	if (eligible.length === 0) return null;

	const top = eligible[0];
	if (!top) return null;
	const runnerUp = eligible[1];
	if (
		runnerUp &&
		runnerUp.shortcut.id !== top.shortcut.id &&
		top.confidence - runnerUp.confidence < SHORTCUT_AMBIGUITY_EPSILON &&
		(top.shortcut.priority ?? 0) === (runnerUp.shortcut.priority ?? 0)
	) {
		// Two near-ties at equal priority → ambiguous; defer to the LLM.
		return null;
	}
	return top;
}

/**
 * Per-agent shortcut store. Mirrors the slash-command registry's per-agentId
 * isolation so multi-agent deployments don't share shortcut state.
 */
export class ShortcutRegistry {
	private readonly byId = new Map<string, ShortcutDefinition>();

	register(definition: ShortcutDefinition): void {
		this.byId.set(definition.id, definition);
	}

	registerMany(definitions: readonly ShortcutDefinition[]): void {
		for (const definition of definitions) this.register(definition);
	}

	unregister(id: string): void {
		this.byId.delete(id);
	}

	clear(): void {
		this.byId.clear();
	}

	list(): ShortcutDefinition[] {
		return [...this.byId.values()];
	}

	get size(): number {
		return this.byId.size;
	}

	match(text: string, context?: ShortcutMatchContext): ShortcutMatch | null {
		return matchShortcut(this.list(), text, context);
	}
}
