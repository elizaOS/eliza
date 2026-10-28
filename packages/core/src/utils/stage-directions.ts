/**
 * Roleplay stage directions (`*beams*`, `*blushes*`, `*smiles warmly*`). A
 * leading verb is not enough: `*look at the stack trace*` and `*looks
 * correct*` are instructions and must stay. Only a bare action, plus a light
 * modifier, counts. Display cleanup and speech share this rule.
 */
const STAGE_DIRECTION_FIRST_WORDS = new Set([
	"beam",
	"beams",
	"beaming",
	"blink",
	"blinks",
	"blinking",
	"blush",
	"blushes",
	"blushing",
	"bow",
	"bows",
	"bowing",
	"breathe",
	"breathes",
	"breathing",
	"cheer",
	"cheers",
	"cheering",
	"chuckle",
	"chuckles",
	"chuckling",
	"clap",
	"claps",
	"clapping",
	"cry",
	"cries",
	"crying",
	"curtsy",
	"curtsies",
	"curtsying",
	"dance",
	"dances",
	"dancing",
	"frown",
	"frowns",
	"frowning",
	"gasp",
	"gasps",
	"gasping",
	"gesture",
	"gestures",
	"gesturing",
	"giggle",
	"giggles",
	"giggling",
	"glance",
	"glances",
	"glancing",
	"grin",
	"grins",
	"grinning",
	"laugh",
	"laughs",
	"laughing",
	"lean",
	"leans",
	"leaning",
	"look",
	"looks",
	"looking",
	"nod",
	"nods",
	"nodding",
	"pause",
	"pauses",
	"pausing",
	"point",
	"points",
	"pointing",
	"pose",
	"poses",
	"posing",
	"pout",
	"pouts",
	"pouting",
	"raise",
	"raises",
	"raising",
	"shrug",
	"shrugs",
	"shrugging",
	"sigh",
	"sighs",
	"sighing",
	"smile",
	"smiles",
	"smiling",
	"smirk",
	"smirks",
	"smirking",
	"spin",
	"spins",
	"spinning",
	"stare",
	"stares",
	"staring",
	"stretch",
	"stretches",
	"stretching",
	"sway",
	"sways",
	"swaying",
	"tilt",
	"tilts",
	"tilting",
	"wave",
	"waves",
	"waving",
	"whisper",
	"whispers",
	"whispering",
	"wink",
	"winks",
	"winking",
	"yawn",
	"yawns",
	"yawning",
]);

/** Words that can follow the action without turning it into an instruction. */
const STAGE_DIRECTION_MODIFIERS = new Set([
	"around",
	"away",
	"back",
	"down",
	"gently",
	"happily",
	"loudly",
	"nervously",
	"quickly",
	"quietly",
	"sadly",
	"shyly",
	"slightly",
	"slowly",
	"softly",
	"up",
	"warmly",
]);

function collapseInlineWhitespace(input: string): string {
	return input.replace(/[ \t]+/g, " ").trim();
}

export function looksLikeStageDirection(input: string): boolean {
	const normalized = collapseInlineWhitespace(input).trim();
	if (!normalized || normalized.length > 100) return false;

	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII-range check to reject non-ASCII input
	if (/[^\x00-\x7F]/.test(normalized)) {
		return false;
	}
	if (/\d/.test(normalized)) return false;

	const words = normalized.match(/[A-Za-z]+/g);
	if (!words || words.length === 0 || words.length > 4) return false;
	const [first, ...rest] = words;
	if (!first || !STAGE_DIRECTION_FIRST_WORDS.has(first.toLowerCase())) {
		return false;
	}
	return rest.every((word) =>
		STAGE_DIRECTION_MODIFIERS.has(word.toLowerCase()),
	);
}
