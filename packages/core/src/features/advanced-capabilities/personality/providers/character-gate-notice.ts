/**
 * Surfaces a high-confidence persistent character/configuration request when
 * the sender cannot access the CHARACTER action. This boundary deliberately
 * favors precision over recall: ordinary turn instructions must not become a
 * false authorization refusal merely because the action classifier accepts
 * broad language after routing. Engagement/disengagement directives ("stop
 * replying", "be quiet", "never respond to everything") are conversation-scoped
 * behavior requests, not configuration changes: they must reach the normal
 * response path — where STOP/IGNORE is available for the turn — instead of
 * being preempted by a scripted permissions refusal.
 */
import { hasRoleAccess, type RoleName } from "../../../../roles.ts";
import { resolveActionRolePolicyRole } from "../../../../runtime/action-role-policy.ts";
import { unwrapUserMessageText } from "../../../../security/incoming-message-security.ts";
import type { RoleGateRole } from "../../../../types/contexts.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
} from "../../../../types/index.ts";

const EMPTY_RESULT: ProviderResult = {
	data: {},
	values: {},
	text: "",
};

const LOCAL_ARTIFACT =
	"(?:answer|chat|code|conversation|document|email|interview|invoice|meeting|message|movie|podcast|presentation|question|rehearsal|reply|report|response|review|spreadsheet|summary|task|thread|transaction)";
const LOCAL_ARTIFACT_BOUNDARY = String.raw`(?=\s*(?:$|[,.!?;:]|(?:and|but|or|only|just)\b|(?:please|kindly)\s*(?:[,.!?;:]\s*)?$))`;
const LOCAL_OCCASION_SCOPE_PATTERNS = [
	new RegExp(
		String.raw`\b(?:in|for|during|within|on)\s+(?:(?:only|just)\s+)?(?:this|my|the\s+current)\s+${LOCAL_ARTIFACT}\b${LOCAL_ARTIFACT_BOUNDARY}`,
		"giu",
	),
	new RegExp(
		String.raw`\bon\s+your\s+${LOCAL_ARTIFACT}\b${LOCAL_ARTIFACT_BOUNDARY}`,
		"giu",
	),
	new RegExp(
		String.raw`\bduring\s+today['’]s\s+${LOCAL_ARTIFACT}\b${LOCAL_ARTIFACT_BOUNDARY}`,
		"giu",
	),
	new RegExp(
		String.raw`\b(?:when|while|as)\s+(?:(?:you|i|we)\s+(?:(?:are|am)\s+)?)?[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,3}\s+(?:this|my|the\s+current)\s+${LOCAL_ARTIFACT}\b${LOCAL_ARTIFACT_BOUNDARY}`,
		"giu",
	),
	/\b(?:for\s+now|right\s+now|this\s+time|just\s+this\s+once)\b/giu,
] as const;
const LOCAL_WITH_SCOPE = new RegExp(
	String.raw`\bwith\s+(?:(?:only|just)\s+)?(?:this|my|the\s+current)\s+${LOCAL_ARTIFACT}\b${LOCAL_ARTIFACT_BOUNDARY}`,
	"giu",
);
const LOCAL_WITH_ACTIVITY_SCOPE = new RegExp(
	String.raw`\bwith\s+(?:(?:only|just)\s+)?(?:this|my|the\s+current)\s+(?:task|transaction)\b${LOCAL_ARTIFACT_BOUNDARY}`,
	"giu",
);
const LOCAL_ABOUT_SCOPE = new RegExp(
	String.raw`\babout\s+(?:(?:only|just)\s+)?(?:this|my|the\s+current)\s+${LOCAL_ARTIFACT}\b${LOCAL_ARTIFACT_BOUNDARY}`,
	"giu",
);
const NEGATED_LOCAL_SCOPE_PREFIX =
	/\b(?:not(?:\s+(?:just|only))?|except(?:\s+(?:just|only))?|rather\s+than(?:\s+(?:just|only))?|instead\s+of(?:\s+(?:just|only))?)\s*$/i;
const REQUEST_CLAUSE_BOUNDARY = /[.!?;\n]+/u;
const ADDITIVE_COORDINATION_BOUNDARY = /(?:,\s*)?\b(?:and|or)\b\s+/iu;
const ADVERSATIVE_COORDINATION_BOUNDARY = /(?:,\s*)?\bbut\b\s+/iu;
const SEMICOLON_ADVERSATIVE = /;\s*(?=but\b)/giu;
const QUOTED_MESSAGE = /^(?:"[\s\S]*"|“[\s\S]*”|'[\s\S]*')$/u;
const UNKNOWN_NAMED_ADDRESS =
	/^(?:(?:[Hh]ey|[Hh]i)\s*[,;:]?\s+([\p{Lu}][\p{L}\p{N}_-]{1,31})|([\p{Lu}][\p{L}\p{N}_-]{1,31}))\s*(?:[,;:.!?]|—|--+)\s*/u;
const LEADING_REQUEST_WORD = /^(?:please|kindly)\b\s*(?:(?:[,;:]|—|--+)\s*)?/i;
const REQUEST_PREFIXES = [
	LEADING_REQUEST_WORD,
	/^(?:can|could|would|will)\s+you\b\s*(?:(?:please|kindly)\b\s*[,;:]?\s*)*/i,
	/^i(?:['’]d|\s+would)\s+like\s+you\s+to\s+/i,
	/^i\s+(?:want|need)\s+you\s+to\s+/i,
] as const;
const PERSISTENT_REQUEST_PREFIX =
	/^(?:from\s+now\s+on|going\s+forward|by\s+default|every\s+time)\b\s*(?:(?:[,;:]|—|--+)\s*)?/i;
const MIND_REQUEST_PREFIX =
	/^(?:can|could|would|do)\s+you\s+mind\s*(?:[,;:]|—|--+)?\s*/i;
const CONFIGURATION_MUTATION =
	/^(?:change|update|modify|adjust|set|configure|reset|rewrite)\s+your\s+(?:personality|character|behaviou?r|tone|voice|language|(?:response|interaction)\s+style|preferences?|configuration|settings?|bio|name|(?:system\s+)?prompt)(?=\s*(?:$|[.!?;,]|\b(?:to|as|into|from|so|back|permanently|forever|going\s+forward)\b))/i;
const CONFIGURATION_GERUND =
	/^(changing|updating|modifying|adjusting|setting|configuring|resetting|rewriting)\b/i;
const COORDINATED_CONFIGURATION_GERUND =
	/((?:[,;]\s*)?\b(?:and|but|or)\b\s+)(changing|updating|modifying|adjusting|setting|configuring|resetting|rewriting)\b/gi;
const STANDING_RULE =
	/^(?:(?:always|never)\s+(?:be|act|behave|answer|respond|reply|speak|talk|say|use|mention)\b|(?:be|act|behave|answer|respond|reply|speak|talk|say|use|mention)\b[\s\S]*\b(?:from\s+now\s+on|going\s+forward|permanently|forever|by\s+default|every\s+time)\b)/i;
const STANDING_BEHAVIOR_START =
	/^(?:be|act|behave|answer|respond|reply|speak|talk|say|use|mention)\b/i;
const AFFIRMATIVE_IMPERATIVE_START =
	/^(?:change|update|modify|adjust|set|configure|reset|rewrite|always|never|be|act|behave|answer|respond|reply|speak|talk|say|use|mention)\b/i;
const NEGATED_IMPERATIVE_START = /^(?:don['’]t|do\s+not)\b/i;
const NEVER_CONFIGURATION_MUTATION =
	/^never\s+(?:change|changing|update|updating|modify|modifying|adjust|adjusting|set|setting|configure|configuring|reset|resetting|rewrite|rewriting)\b/i;
const TALK_OR_SPEAK = /^(?:always|never)\s+(?:talk|speak)\b/i;
const EXPLICIT_PERSISTENT_SCOPE =
	/\b(?:from\s+now\s+on|going\s+forward|permanently|forever|by\s+default|every\s+time)\b/i;
const GERUND_TO_IMPERATIVE = new Map<string, string>([
	["changing", "change"],
	["updating", "update"],
	["modifying", "modify"],
	["adjusting", "adjust"],
	["setting", "set"],
	["configuring", "configure"],
	["resetting", "reset"],
	["rewriting", "rewrite"],
]);

// Disengagement grammar: a cessation or quieting predicate whose tail carries
// only an audience, extent, or persistence marker. Content-bearing tails
// ("never reply with your real name", "keep quiet about the merger") fail the
// tail match and stay on the configuration side.
const DISENGAGEMENT_AUDIENCE = String.raw`(?:(?:to|with|at)\s+)?(?:me|us|him|her|them|everyone|everybody|anyone|anybody|all|people|others|every\s+(?:message|msg|post|thread)|everything)`;
const DISENGAGEMENT_EXTENT = String.raw`(?:again|anymore|any\s+more|ever|at\s+all|so\s+(?:much|often)|all\s+the\s+time|constantly|nonstop|non-stop|first|unprompted|unsolicited|here|in\s+here|in\s+(?:this|the)\s+(?:chat|channel|conversation|group|room|server|thread)|right\s+now|for\s+now|please|kindly|from\s+now\s+on|going\s+forward|permanently|forever|by\s+default|every\s+time)`;
const DISENGAGEMENT_TAIL = String.raw`(?:[\s,]+(?:${DISENGAGEMENT_AUDIENCE}|${DISENGAGEMENT_EXTENT}))*[\s,]*$`;
const CESSATION_PREFIX = String.raw`(?:never|stop|quit|cease|don['’]t|do\s+not|no\s+longer)`;
const COMMUNICATION_CESSATION_VERB = String.raw`(?:answer(?:ing)?|respond(?:ing)?|repl(?:y|ying)|speak(?:ing)?|talk(?:ing)?|messag(?:e|ing)|text(?:ing)?|ping(?:ing)?|dm(?:['’]?ing)?)`;
const QUIETING_PREDICATE = String.raw`(?:(?:be|stay|remain|keep)\s+(?:quiet|silent)|shut\s+up|pipe\s+down)`;
const DISENGAGEMENT_DIRECTIVE = new RegExp(
	String.raw`^(?:(?:please|kindly|just)\s+)*(?:${CESSATION_PREFIX}\s+(?:ever\s+)?${COMMUNICATION_CESSATION_VERB}\b${DISENGAGEMENT_TAIL}|(?:(?:always|never|just|please)\s+)*${QUIETING_PREDICATE}\b${DISENGAGEMENT_TAIL})`,
	"iu",
);

/**
 * Recognizes conversation-scoped disengagement directives so they never gate.
 * These asks are satisfiable on the normal response path (which can choose
 * STOP/IGNORE for the turn), so treating them as gated configuration requests
 * would replace a graceful exit with an authorization retort.
 */
function isDisengagementDirective(body: string): boolean {
	return DISENGAGEMENT_DIRECTIVE.test(body);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripKnownAddress(
	text: string,
	agentName: string | undefined,
): string {
	const name = agentName?.trim() ?? "";
	if (!name) return text;
	return text.replace(
		new RegExp(
			`^(?:(?:hey|hi)\\s*[,;:]?\\s+)?${escapeRegExp(name)}\\s*(?:(?:[,;:.!?]|—|--+)\\s*|\\s+)`,
			"i",
		),
		"",
	);
}

interface NormalizedRequestBody {
	body: string;
	hasMindRequest: boolean;
	hasPersistentRequestPrefix: boolean;
}

function normalizeRequestBody(
	text: string,
	agentName: string | undefined,
): NormalizedRequestBody {
	let body = stripKnownAddress(text.trim(), agentName);
	let hasMindRequest = false;
	let hasPersistentRequestPrefix = false;
	for (let depth = 0; depth < 4; depth++) {
		const previous = body;
		body = stripKnownAddress(body, agentName).trimStart();
		const mindPrefix = body.match(MIND_REQUEST_PREFIX);
		if (mindPrefix) {
			hasMindRequest = true;
			body = body.slice(mindPrefix[0].length).trimStart();
		} else {
			const persistentPrefix = body.match(PERSISTENT_REQUEST_PREFIX);
			if (persistentPrefix) {
				hasPersistentRequestPrefix = true;
				body = body.slice(persistentPrefix[0].length).trimStart();
				continue;
			}
			for (const prefix of REQUEST_PREFIXES) {
				const stripped = body.replace(prefix, "");
				if (stripped !== body) {
					body = stripped.trimStart();
					break;
				}
			}
		}
		if (body === previous) break;
	}
	if (hasMindRequest) {
		body = body.replace(CONFIGURATION_GERUND, (gerund) => {
			return GERUND_TO_IMPERATIVE.get(gerund.toLowerCase()) ?? gerund;
		});
	}
	return { body, hasMindRequest, hasPersistentRequestPrefix };
}

function requestBody(text: string, agentName: string | undefined): string {
	return normalizeRequestBody(text, agentName).body;
}

function normalizeMindCoordination(body: string): string {
	return body.replace(
		COORDINATED_CONFIGURATION_GERUND,
		(_match, conjunction: string, gerund: string) => {
			return `${conjunction}${GERUND_TO_IMPERATIVE.get(gerund.toLowerCase()) ?? gerund}`;
		},
	);
}

function isHighConfidencePersistentRequest(
	text: string,
	agentName: string | undefined,
): boolean {
	const addressCandidate = text.trim().replace(LEADING_REQUEST_WORD, "").trim();
	const namedAddressMatch = addressCandidate.match(UNKNOWN_NAMED_ADDRESS);
	const namedAddress = namedAddressMatch?.[1] ?? namedAddressMatch?.[2];
	if (
		namedAddress &&
		namedAddress.toLocaleLowerCase() !== agentName?.trim().toLocaleLowerCase()
	) {
		return false;
	}
	return requestClauses(text, agentName).some((clause) =>
		isPersistentRequestClause(clause, agentName),
	);
}

function requestClauses(text: string, agentName: string | undefined): string[] {
	const trimmed = text.trim();
	if (QUOTED_MESSAGE.test(trimmed)) return [text];
	const normalized = normalizeRequestBody(text, agentName);
	const scopedText = normalized.hasMindRequest
		? normalizeMindCoordination(normalized.body)
		: text;
	const semicolonAdversative = splitAdversativeClause(
		scopedText.replace(SEMICOLON_ADVERSATIVE, ", "),
		agentName,
	);
	if (semicolonAdversative.length > 1) {
		return semicolonAdversative.flatMap((part) =>
			splitAdditiveClause(part, agentName),
		);
	}
	const sentenceClauses = scopedText.split(REQUEST_CLAUSE_BOUNDARY);
	const leadingClause = sentenceClauses[0] ?? "";
	if (
		sentenceClauses.length > 1 &&
		!isAffirmativeAlternative(requestBody(leadingClause, agentName)) &&
		splitAdversativeClause(leadingClause, agentName).length === 1
	) {
		return [scopedText];
	}
	return sentenceClauses.flatMap((clause) => {
		const adversative = splitAdversativeClause(clause, agentName);
		return adversative.flatMap((part) => splitAdditiveClause(part, agentName));
	});
}

function splitAdversativeClause(
	clause: string,
	agentName: string | undefined,
): string[] {
	const alternatives = clause.split(ADVERSATIVE_COORDINATION_BOUNDARY);
	if (alternatives.length < 2) return [clause];
	const bodies = alternatives.map((part) => requestBody(part, agentName));
	const firstStartsCommand =
		isAffirmativeAlternative(bodies[0] ?? "") ||
		NEGATED_IMPERATIVE_START.test(bodies[0] ?? "") ||
		NEVER_CONFIGURATION_MUTATION.test(bodies[0] ?? "");
	return firstStartsCommand &&
		bodies.slice(1).every((body) => isAffirmativeAlternative(body))
		? alternatives
		: [clause];
}

function splitAdditiveClause(
	clause: string,
	agentName: string | undefined,
): string[] {
	const alternatives = clause.split(ADDITIVE_COORDINATION_BOUNDARY);
	return alternatives.length > 1 &&
		alternatives.every((part) =>
			isAffirmativeAlternative(requestBody(part, agentName)),
		)
		? alternatives
		: [clause];
}

function isAffirmativeAlternative(body: string): boolean {
	return (
		AFFIRMATIVE_IMPERATIVE_START.test(body) &&
		!NEVER_CONFIGURATION_MUTATION.test(body)
	);
}

function isPersistentRequestClause(
	clause: string,
	agentName: string | undefined,
): boolean {
	const normalized = normalizeRequestBody(clause, agentName);
	const body = normalized.body;
	const isConfigurationMutation = CONFIGURATION_MUTATION.test(body);
	const isStandingRule =
		STANDING_RULE.test(body) ||
		(normalized.hasPersistentRequestPrefix &&
			STANDING_BEHAVIOR_START.test(body));
	if (!isConfigurationMutation && !isStandingRule) return false;
	// A standing-rule match whose content is disengagement ("never reply to
	// me", "always be quiet") is an engagement request, not a configuration
	// change; leave the turn to normal handling where STOP is reachable.
	if (!isConfigurationMutation && isDisengagementDirective(body)) {
		return false;
	}
	if (hasAffirmativeLocalScope(clause, LOCAL_OCCASION_SCOPE_PATTERNS)) {
		return false;
	}
	if (
		hasAffirmativeLocalScope(clause, [LOCAL_ABOUT_SCOPE]) &&
		!(isStandingRule && TALK_OR_SPEAK.test(body))
	) {
		return false;
	}
	if (!hasAffirmativeLocalScope(clause, [LOCAL_WITH_SCOPE])) return true;
	if (isConfigurationMutation) return EXPLICIT_PERSISTENT_SCOPE.test(clause);
	return !(
		isStandingRule &&
		hasAffirmativeLocalScope(clause, [LOCAL_WITH_ACTIVITY_SCOPE])
	);
}

function hasAffirmativeLocalScope(
	text: string,
	patterns: readonly RegExp[],
): boolean {
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			if (!NEGATED_LOCAL_SCOPE_PREFIX.test(text.slice(0, match.index))) {
				return true;
			}
		}
	}
	return false;
}

function accessRoleForGate(minRole: RoleGateRole): RoleName | null {
	switch (minRole) {
		case "OWNER":
		case "ADMIN":
			return minRole;
		case "MEMBER":
		case "USER":
			return "USER";
		default:
			return null;
	}
}

export const characterGateNoticeProvider: Provider = {
	name: "CHARACTER_GATE_NOTICE",
	description:
		"Flags a high-confidence persistent character/configuration request from a sender below the CHARACTER action's role gate",
	dynamic: true,
	// Low-role turns lose settings context before providers are selected, so the
	// notice must remain available without making ordinary requests look gated.
	alwaysInResponseState: true,

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ProviderResult> => {
		const text = unwrapUserMessageText(message);
		if (!isHighConfidencePersistentRequest(text, runtime.character.name)) {
			return EMPTY_RESULT;
		}

		const characterAction = (runtime.actions ?? []).find(
			(action) => action.name === "CHARACTER",
		);
		if (!characterAction) return EMPTY_RESULT;

		const minRole =
			resolveActionRolePolicyRole(characterAction) ??
			characterAction.roleGate?.minRole ??
			characterAction.contextGate?.roleGate?.minRole;
		if (!minRole) return EMPTY_RESULT;
		const accessRole = accessRoleForGate(minRole);
		if (!accessRole || (await hasRoleAccess(runtime, message, accessRole))) {
			return EMPTY_RESULT;
		}

		const noticeText = [
			"# Character modification access notice",
			`The current message asks to change the agent's persistent character, personality, or behavior, but that capability requires the ${minRole} role and this sender does not have it. The character tools are not available on this turn.`,
			`Do not promise, imply, or claim any persistent change was or will be applied. Acknowledge in your own voice that changing this configuration requires the ${minRole} role.`,
		].join("\n");
		return {
			data: { characterGateNotice: { requiredRole: minRole } },
			values: { characterModificationGated: true, requiredRole: minRole },
			text: noticeText,
		};
	},
};
