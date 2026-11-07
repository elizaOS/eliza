/**
 * Explicit-recurrence detection for cadence guards: does the user's own text
 * state a REPEATING schedule? This is deliberately narrower than the
 * `lifeops_cadence` keyword doc — that doc also carries time-of-day WINDOW
 * phrases ("in the morning", "before bed", "after work") used for window
 * extraction, and a window phrase in a one-shot ask ("remind me to call mom
 * in the morning") is not a recurrence statement. Guards that consumed the
 * full doc flipped both ways: one-shot reminders lost their run cap and
 * one-off calendar events kept model-invented RRULEs.
 *
 * ASCII languages match on word boundaries with schedule-noun anchoring so
 * quantifier uses ("invite every member") stay out; CJK matches by substring.
 */

// Spelled-out counts accepted wherever a digit count is ("every two weeks",
// "three times a day" read the same as "every 2 weeks", "3 times a day").
const ENGLISH_COUNT_WORD =
	"(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)";
// The same counts in Spanish ("cada dos semanas", "tres veces por semana") and
// Portuguese ("a cada duas semanas", "três vezes ao dia").
const SPANISH_COUNT_WORD =
	"(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta)";
const PORTUGUESE_COUNT_WORD =
	"(?:dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta)";

const ASCII_RECURRENCE_PATTERNS: readonly RegExp[] = [
	// en: every/each anchored to a schedule noun within the phrase
	new RegExp(
		String.raw`\b(?:every|each)\s+(?:(?:other|\d+|${ENGLISH_COUNT_WORD})\s+)?(?:second|minute|hour|day|week|month|year|morning|afternoon|evening|night|weekday|weekend|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b`,
		"i",
	),
	/\bdaily\b/i,
	/\b(?:weekly|monthly|nightly|hourly|yearly|annually|quarterly|biweekly|fortnightly)\b/i,
	/\brepeat(?:s|ing)\b|\brecurring\b|\brecurs?\b/i,
	new RegExp(
		String.raw`\b(?:once|twice|thrice|(?:\d+\s*|${ENGLISH_COUNT_WORD}\s+)times)\s+(?:a|per|each|every)\s+(?:day|week|month|year)\b`,
		"i",
	),
	/\bper\s+(?:day|week|month|year)\b/i,
	/\b(?:on\s+)?(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i,
	/\b(?:weekdays|weekends)\b/i,
	// es: cada [count] / todos los / todas las + schedule noun; adjective forms
	new RegExp(
		String.raw`\b(?:cada(?:\s+(?:\d+|${SPANISH_COUNT_WORD}))?|todos\s+los|todas\s+las)\s+(?:d[ií]as?|semanas?|mes(?:es)?|años?|horas?|minutos?|mañanas?|noches?|tardes?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\b`,
		"i",
	),
	/\bdiario\b/i,
	/\b(?:diaria(?:mente)?|semanal(?:mente)?|mensual(?:mente)?|anual(?:mente)?)\b/i,
	/\blos\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados|domingos)\b/i,
	new RegExp(
		String.raw`\b(?:una\s+vez|(?:\d+\s*|${SPANISH_COUNT_WORD}\s+)veces)\s+(?:al|a\s+la|por)\s+(?:d[ií]a|semana|mes|año)\b`,
		"i",
	),
	// pt: cada [count] / todos os / todas as + schedule noun; adjective forms.
	// The closing boundary is Unicode-aware: an ASCII \b never follows "manhã".
	new RegExp(
		String.raw`\b(?:cada(?:\s+(?:\d+|${PORTUGUESE_COUNT_WORD}))?|todos\s+os|todas\s+as)\s+(?:dias?|semanas?|m[eê]s(?:es)?|anos?|horas?|minutos?|manh[aã]s?|noites?|tardes?|segundas?|ter[cç]as?|quartas?|quintas?|sextas?|s[aá]bados?|domingos?)(?![\p{L}\p{N}_])`,
		"iu",
	),
	/\b(?:diariamente|semanal(?:mente)?|mensal(?:mente)?|anual(?:mente)?)\b/i,
	/\b(?:toda|todo)\s+(?:semana|m[eê]s|ano|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i,
	new RegExp(
		String.raw`\b(?:uma\s+vez|(?:\d+\s*|${PORTUGUESE_COUNT_WORD}\s+)vezes)\s+(?:por|ao|à)\s+(?:dia|semana|m[eê]s|ano)(?![\p{L}\p{N}_])`,
		"iu",
	),
	// vi: mỗi / hàng + schedule noun
	/(?:mỗi|hàng|hằng)\s*(?:ngày|tuần|tháng|năm|sáng|tối|chiều)/i,
	// tl: reduplicated schedule nouns and "tuwing"
	/\b(?:araw-araw|linggo-linggo|buwan-buwan|taon-taon|gabi-gabi|tuwing|bawat\s+(?:araw|linggo|buwan|taon))\b/i,
];

// CJK repetition markers — substring matches (no word boundaries).
const CJK_RECURRENCE_MARKERS: readonly string[] = [
	// zh-CN
	"每天",
	"每日",
	"每周",
	"每星期",
	"每个星期",
	"每月",
	"每个月",
	"每年",
	"天天",
	"周一到周五",
	"一周一次",
	"每逢",
	// ko — 마다 is the productive "every" suffix
	"마다",
	"매일",
	"매주",
	"매월",
	"매달",
	"매년",
	"격주",
];

// Japanese is a shipped UI locale. Keep name-like newspaper/broadcaster uses
// out while accepting productive "every" and interval/count constructions.
const JAPANESE_RECURRENCE_PATTERNS: readonly RegExp[] = [
	/毎日(?!新聞|放送)/,
	/毎(?:週|月|年|朝|晩|夜|回|曜日)/,
	/(?:隔週|隔月|隔年)/,
	/(?:日|週|月|年)に(?:一|1|二|2|三|3)(?:度|回)/,
	/(?:一|1|二|2|三|3)(?:日|週|か月|ヶ月|年)ごと/,
];

const NAME_LIKE_RECURRENCE_PATTERNS: readonly RegExp[] = [
	/\bDaily\s+Planet\b/g,
	/\b(?:el|un|este)\s+Diario\b/g,
];

// Negative/one-shot directives participate in the same ordered intent stream
// as positive cadence markers. The last explicit directive wins, while a
// positive marker nested inside "not every..." is ignored. Cadence
// adjectives ("not weekly") and plural weekday nouns ("not on Mondays")
// negate the same way as determiner forms — a directly negated cadence word
// is a one-shot statement, not a recurring one. "Only once a week" remains
// recurring because the one-shot expression is followed by a cadence unit.
const NEGATION_WORD = String.raw`\b(?:not|no|never|isn't|isn’t|aren't|aren’t|won't|won’t|doesn't|doesn’t|don't|don’t)\b`;
const CADENCE_ADJECTIVE = String.raw`\b(?:daily|weekly|monthly|nightly|hourly|yearly|annually|quarterly|biweekly|fortnightly)\b`;
const PLURAL_WEEKDAY = String.raw`\bmondays\b|\btuesdays\b|\bwednesdays\b|\bthursdays\b|\bfridays\b|\bsaturdays\b|\bsundays\b|\bweekdays\b|\bweekends\b`;
const ONE_SHOT_DIRECTIVE_PATTERNS: readonly RegExp[] = [
	new RegExp(
		`${NEGATION_WORD}\\s+(?:a\\s+)?(?:recurr(?:ing|ence)|repeat(?:ed|ing)?|every|each)\\b(?:(?![,.;!?]|\\b(?:but|rather|instead|actually|make\\s+it)\\b)[\\s\\S])*`,
		"i",
	),
	new RegExp(
		// "not weekly" / "never daily on Mondays": a negated cadence adjective
		// (optionally followed by more cadence words) is one authoritative
		// one-shot span that swallows any positive markers it covers.
		`${NEGATION_WORD}\\s+(?:on\\s+|a\\s+|an\\s+)?(?:${CADENCE_ADJECTIVE}|${PLURAL_WEEKDAY})(?:\\s+(?:or|and)\\s+(?:${CADENCE_ADJECTIVE}|${PLURAL_WEEKDAY}))*(?:(?![,.;!?]|\\b(?:but|rather|instead|actually|make\\s+it)\\b)[\\s\\S])*`,
		"i",
	),
	/\b(?:do\s+not|don't)\s+repeat\b(?:(?![,.;!?]|\b(?:but|rather|instead|actually|make\s+it)\b)[\s\S])*/i,
	/\b(?:just|only)\s+(?:once|one\s+time)\b(?!\s+(?:a|per|each|every)\s+(?:day|week|month|year))/i,
	/\b(?:once|one\s+time)\s+only\b/i,
	/(?:一度だけ|1回だけ)/,
	/(?:繰り返さない|毎日ではない)(?:(?![、。！？]|(?:代わり|むしろ|実際には))[\s\S])*/,
];

type IntentMarker = {
	end: number;
	kind: "one-shot" | "recurrence";
	start: number;
};

// matchAll needs the global flag. Compile the global forms once; matchAll
// clones its regex, so the shared instances never carry lastIndex state.
function toGlobal(patterns: readonly RegExp[]): readonly RegExp[] {
	return patterns.map((pattern) =>
		pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`),
	);
}
const GLOBAL_ONE_SHOT_PATTERNS = toGlobal(ONE_SHOT_DIRECTIVE_PATTERNS);
const GLOBAL_RECURRENCE_PATTERNS = toGlobal([
	...ASCII_RECURRENCE_PATTERNS,
	...JAPANESE_RECURRENCE_PATTERNS,
]);
const ROLE_LABELS = new Set(["user", "owner", "assistant", "agent", "system"]);

function pushPatternMatches(
	out: IntentMarker[],
	text: string,
	patterns: readonly RegExp[],
	kind: IntentMarker["kind"],
): void {
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			out.push({
				end: match.index + match[0].length,
				kind,
				start: match.index,
			});
		}
	}
}

function orderedIntentMarkers(text: string): IntentMarker[] {
	const sanitized = NAME_LIKE_RECURRENCE_PATTERNS.reduce(
		(value, pattern) =>
			value.replace(pattern, (match) => " ".repeat(match.length)),
		text,
	);
	const oneShot: IntentMarker[] = [];
	pushPatternMatches(oneShot, sanitized, GLOBAL_ONE_SHOT_PATTERNS, "one-shot");
	const recurrence: IntentMarker[] = [];
	pushPatternMatches(
		recurrence,
		sanitized,
		GLOBAL_RECURRENCE_PATTERNS,
		"recurrence",
	);
	for (const marker of CJK_RECURRENCE_MARKERS) {
		let start = sanitized.indexOf(marker);
		while (start >= 0) {
			recurrence.push({
				end: start + marker.length,
				kind: "recurrence",
				start,
			});
			start = sanitized.indexOf(marker, start + marker.length);
		}
	}
	const nonNegatedRecurrence = recurrence.filter(
		(positive) =>
			!oneShot.some(
				(negative) =>
					positive.start >= negative.start && positive.start < negative.end,
			),
	);
	return [...oneShot, ...nonNegatedRecurrence].sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
}

function authoritativeSegments(text: string): string[] {
	return text
		.split(/\n+/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const colonIndex = line.indexOf(":");
			if (colonIndex < 0) return [line];
			const role = line.slice(0, colonIndex).trim().toLowerCase();
			if (!ROLE_LABELS.has(role)) {
				return [line];
			}
			return role === "user" || role === "owner"
				? [line.slice(colonIndex + 1).trimStart()]
				: [];
		});
}

/**
 * True when authoritative user-authored text states a repeating cadence.
 * Role-labelled assistant/system text is ignored, and an explicit one-shot
 * correction in the same input takes precedence over recurrence keywords.
 */
export function textStatesExplicitRecurrence(
	...texts: ReadonlyArray<string | null | undefined>
): boolean {
	const segments = texts.flatMap((text) =>
		typeof text === "string" ? authoritativeSegments(text) : [],
	);
	const markers = segments.flatMap(orderedIntentMarkers);
	return markers.at(-1)?.kind === "recurrence";
}

/**
 * Returns the first model-authored recurrence source only when authoritative
 * user text explicitly permits recurrence. Callers provide sources in their
 * existing precedence order (outer planner, domain extraction, fallback).
 */
export function selectUserAuthorizedRecurrence<T>(
	authoritativeTexts: ReadonlyArray<string | null | undefined>,
	sources: ReadonlyArray<T | null | undefined>,
): T | undefined {
	if (!textStatesExplicitRecurrence(...authoritativeTexts)) return undefined;
	return sources.find((source): source is T => source != null);
}
