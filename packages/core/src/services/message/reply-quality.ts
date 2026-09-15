/** Recognizes unusable replies and preserves explicit terse or literal reply requests. */

/**
 * Answer-free refusal stubs, matched against the WHOLE normalized reply after
 * an optional leading apology ("I'm sorry, but …") is stripped. A refusal that
 * continues into content ("I'm not sure, but my best guess is …") never
 * matches, and a bare social apology ("Sorry.") is a legitimate reply, not a
 * refusal.
 */
export const STAGE1_BARE_REFUSAL_STUBS: ReadonlySet<string> = new Set([
	"i am not sure",
	"i'm not sure",
	"i am not sure how to answer that",
	"i'm not sure how to answer that",
	"i don't know",
	"i do not know",
	"i can't help with that",
	"i cannot help with that",
	"i can't answer that",
	"i cannot answer that",
	"i am unable to help with that",
	"i am unable to answer that",
]);

export function isBareRefusalStage1Reply(trimmed: string): boolean {
	const normalized = trimmed
		.toLowerCase()
		.replace(/[’‘]/gu, "'")
		.replace(/\s+/gu, " ")
		.replace(/[.!?]+$/u, "")
		.trim();
	const withoutApology = normalized.replace(
		/^(?:i am sorry|i'm sorry|sorry|my apologies|i apologize)[,.!]?\s*(?:but\s+)?/u,
		"",
	);
	return STAGE1_BARE_REFUSAL_STUBS.has(withoutApology);
}

export function isUnusableStage1Reply(reply: string | undefined): boolean {
	const trimmed = typeof reply === "string" ? reply.trim() : "";
	if (!trimmed) return true;
	if (/^```[a-z0-9_-]*\s+/iu.test(trimmed)) return false;
	// A bare refusal stub carries no answer — defer instead of shipping it
	// (#11504 asked to tighten the unusable signal to actual refusals/empties).
	// Refusal-plus-content and bare social apologies never match.
	if (isBareRefusalStage1Reply(trimmed)) return true;
	if (/^[\s{}[\]":,]+$/.test(trimmed)) return true;
	if (/^\d+$/.test(trimmed)) return true;
	// Degenerate single-character spam: the WHOLE reply is one code point
	// repeated 5+ times ("aaaaa", "!!!!!", "aaaaa aaaaa" across whitespace).
	// A repeated run INSIDE a longer reply is legitimate — nested code
	// indentation, aligned `df -h` columns, markdown "-----" dividers, an
	// "XXXXXXXX" placeholder, pretty-printed JSON — and matching those blanked
	// valid replies to "I'm not sure how to answer that." (#11504).
	const nonWhitespace = [...trimmed.replace(/\s+/gu, "")];
	if (nonWhitespace.length >= 5 && new Set(nonWhitespace).size === 1) {
		return true;
	}
	// Multi-token degenerate spam: EVERY whitespace-separated token is a single
	// character repeated 5+ times ("aaaaa bbbbb"). Checked per token — an
	// alternation regex over the whole reply backtracks catastrophically.
	if (trimmed.split(/\s+/u).every((token) => /^(\S)\1{4,}$/u.test(token))) {
		return true;
	}
	if (/^[A-Z]{2,8}$/.test(trimmed)) {
		const allowed = new Set(["OK", "YES", "NO", "STOP"]);
		return !allowed.has(trimmed);
	}
	return false;
}

export const EXACT_WORD_COUNT_BY_NAME: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
};

export function parseExactWordsInstruction(
	text: string | null | undefined,
): { literal: string; expectedCount?: number } | null {
	const input = text?.trim();
	if (!input) return null;
	const match = input.match(
		/\b(?:reply|respond|say|output|return)\s+with\s+exactly\s+(?:these\s+)?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?words?\s*:\s*([\s\S]+?)\s*$/i,
	);
	if (!match) return null;
	const literal = (match[2] ?? "")
		.trim()
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.trim();
	if (!literal) return null;
	const countRaw = match[1]?.toLowerCase();
	const expectedCount =
		countRaw === undefined
			? undefined
			: /^\d+$/.test(countRaw)
				? Number.parseInt(countRaw, 10)
				: EXACT_WORD_COUNT_BY_NAME[countRaw];
	return { literal, expectedCount };
}

export function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

export function stripIncidentalTerminalPeriod(text: string): string {
	return text.endsWith(".") ? text.slice(0, -1).trimEnd() : text;
}

export function isRequestedTerseLiteralReply(args: {
	reply: string | undefined;
	messageText: string | null | undefined;
}): boolean {
	const reply = typeof args.reply === "string" ? args.reply.trim() : "";
	if (!reply) return false;
	const instruction = parseExactWordsInstruction(args.messageText);
	if (!instruction) return false;
	if (
		instruction.expectedCount !== undefined &&
		(!Number.isFinite(instruction.expectedCount) ||
			instruction.expectedCount <= 0 ||
			wordCount(reply) !== instruction.expectedCount)
	) {
		return false;
	}
	const requested = instruction.literal;
	if (reply === requested) return true;
	return reply === stripIncidentalTerminalPeriod(requested);
}

/**
 * Recognize a simple imperative to emit ONE specific literal token, e.g.
 * "Say PONG", "say pong", "please say PONG", "can you say PONG", "reply with OK",
 * "respond with the word HELLO", "output PONG!", and the quantified forms
 * "Reply with the single word: PONG" / "reply with one word: PONG" (the
 * acceptance-gate smoke phrasing). The lightweight sibling of
 * {@link parseExactWordsInstruction} (which requires the explicit
 * "...with exactly N words: ..." form). Anchored to the whole message and a
 * single word, so it only fires on a clear "say <token>" request — not
 * "say something nice about cats". Between the verb and the literal only
 * complete connector units may appear ("with", "the word", "the single word",
 * "one word", …) — never bare determiners, so "write a poem" cannot parse as
 * a request to say "poem". Returns the requested literal or null.
 */
export function parseSayLiteralInstruction(
	text: string | null | undefined,
): string | null {
	const input = text?.trim();
	if (!input) return null;
	// Strip a leading connector mention prefix ("Name (@123) ", "<@123> ",
	// "@name ") so "say PONG" still parses when the user @-mentioned the agent
	// first — Discord/Telegram render the mention into the message text, which
	// the anchored matcher below would otherwise reject.
	const body = input
		.replace(/^\s*(?:<@!?\d+>\s*|@\S+\s+|[^()\n]{0,80}\(@\d+\)\s*)/u, "")
		.trim();
	const match = body.match(
		/^(?:(?:can|could|would|will)\s+you\s+|please\s+|just\s+|kindly\s+){0,3}(?:say|reply|respond|answer|output|return|write|type|echo|print)(?:\s+(?:with|back|(?:(?:the|a|an)\s+)?(?:single|one)\s+(?:word|phrase|token)|the\s+(?:word|phrase|token))){0,2}\s*:?\s*["'“”‘’]?([\p{L}\p{N}]{1,40})["'“”‘’]?\s*[.!?]*$/iu,
	);
	return match ? match[1] : null;
}

export function isTerseReplyWorthKeeping(args: {
	reply: string | undefined;
	messageText?: string | null;
}): boolean {
	const reply = args.reply;
	const trimmed = typeof reply === "string" ? reply.trim() : "";
	if (/^\d+$/.test(trimmed)) return true;
	if (isRequestedTerseLiteralReply({ reply, messageText: args.messageText })) {
		return true;
	}
	// The user explicitly asked the agent to say a specific token and it did
	// (case-insensitive) — that reply is intentional, not the enum/scaffold
	// leakage isUnusableStage1Reply guards against. Keep it instead of deferring,
	// so "Say PONG"/"Say HELLO" don't dead-end into "I'm not sure how to answer
	// that." just because the reply is an all-caps short word.
	const requested = parseSayLiteralInstruction(args.messageText);
	if (requested && trimmed) {
		const norm = (s: string) =>
			s
				.trim()
				.replace(/[.!?]+$/, "")
				.trim()
				.toLowerCase();
		if (norm(trimmed) === norm(requested)) return true;
	}
	return false;
}
