import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { ActionMode } from "../../../types/index.ts";
import { resolveAdminContext } from "../services/adminContext.ts";

// ─── Heuristic helpers ──────────────────────────────────────────────────────

const invisibleCharsPattern =
	/\u200b|\u200c|\u200d|\u200e|\u200f|\ufeff|\u00ad|\u034f|\u061c|\u115f|\u1160|\u17b4|\u17b5|[\u180b-\u180e]|[\u2000-\u200a]|\u2028|\u2029|[\u202a-\u202f]|[\u2060-\u2064]|[\u2066-\u206f]|\u3164|[\ufe00-\ufe0f]|\uffa0/g;

function stripInvisible(text: string): string {
	return text.replace(invisibleCharsPattern, "");
}

function looksLikeBase64(text: string): boolean {
	const stripped = text.trim();
	return /^[A-Za-z0-9+/]{16,}={0,2}$/.test(stripped);
}

function looksLikeHex(text: string): boolean {
	return /^([0-9a-fA-F]{2}\s+){8,}[0-9a-fA-F]{2}$/.test(text.trim());
}

function hasLeetSpeak(text: string): boolean {
	const leetChars = text.match(/[01345@7]/g);
	const letterChars = text.match(/[a-zA-Z]/g);
	if (!leetChars || !letterChars) return false;
	const ratio = leetChars.length / (leetChars.length + letterChars.length);
	return ratio > 0.15 && leetChars.length >= 4;
}

function hasTokenSplitting(text: string): boolean {
	let consecutive = 0;
	let maxConsecutive = 0;
	const words = text.split(/\s+/);
	for (const w of words) {
		if (w.length <= 3 && /^[a-zA-Z]+$/.test(w)) {
			consecutive++;
			maxConsecutive = Math.max(maxConsecutive, consecutive);
		} else {
			consecutive = 0;
		}
	}
	return maxConsecutive >= 5;
}

function hasStructuralInjection(text: string): boolean {
	const patterns = [
		/<\|im_start\|>/i,
		/<\|im_end\|>/i,
		/\[INST\]/i,
		/\[\/INST\]/i,
		/\[SYS\]/i,
		/"role"\s*:\s*"system"/i,
		/```system\n/i,
		/END OF SYSTEM PROMPT/i,
		/NEW SYSTEM PROMPT/i,
		/ACTUAL INSTRUCTIONS:/i,
	];
	return patterns.some((p) => p.test(text));
}

function hasMultiLanguageInjection(text: string): boolean {
	const patterns = [
		/ignora\s+(todas\s+)?las\s+instrucciones/i,
		/ignorez\s+toutes\s+les\s+instructions/i,
		/ignoriere\s+alle\s+vorherigen\s+anweisungen/i,
		/игнорируй\s+все\s+предыдущие\s+инструкции/i,
		/игнорируй.*инструкции/i,
		/忽略.*指令/,
		/忽略.*之前/,
		/指示を無視/,
		/無視して/,
		/무시하고/,
		/지시를\s*무시/,
		/تجاهل.*التعليمات/,
	];
	return patterns.some((p) => p.test(text));
}

const NEGATION_RE =
	/(?:never|don'?t|do\s+not|avoid|stop)\s+(?:ever\s+)?(?:share|send|give|post|reveal|provide)/i;

const HIGH_CONFIDENCE_SIGNALS = new Set([
	"ignore_previous",
	"disregard_instructions",
	"system_override",
	"bypass_security",
	"jailbreak_keyword",
	"mode_override",
	"structural_injection",
	"multi_language_injection",
	"credential_request",
	"privilege_request",
	"prompt_extraction",
	"escalation_request",
	"urgency_pressure",
	"authority_claim",
	"scam_keywords",
	"verification_scam",
]);

function detectHeuristicSignals(text: string): string[] {
	const signals: string[] = [];
	const cleaned = stripInvisible(text);
	const lower = cleaned.toLowerCase();

	if (looksLikeBase64(text)) signals.push("base64_encoding");
	if (looksLikeHex(text)) signals.push("hex_encoding");
	if (hasLeetSpeak(text)) signals.push("leet_speak");
	if (hasTokenSplitting(text)) signals.push("token_splitting");
	if (cleaned.length !== text.length) signals.push("invisible_characters");

	if (hasStructuralInjection(text)) signals.push("structural_injection");

	if (hasMultiLanguageInjection(text)) signals.push("multi_language_injection");

	const injectionPatterns = [
		{
			re: /ignore\s+(all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|context)/i,
			name: "ignore_previous",
		},
		{
			re: /disregard\s+(your\s+|all\s+)?(?:previous|prior|system)?\s*(?:instructions|prompts|commands|rules)/i,
			name: "disregard_instructions",
		},
		{
			re: /(?:new|override|updated?)\s+(?:system\s+)?instructions/i,
			name: "new_instructions",
		},
		{ re: /system\s+override/i, name: "system_override" },
		{
			re: /bypass\s+(?:all\s+)?(?:security|safety|checks|restrictions|filters)/i,
			name: "bypass_security",
		},
		{ re: /you\s+are\s+now\s+/i, name: "identity_override" },
		{ re: /pretend\s+(?:you\s+are|to\s+be)/i, name: "pretend_identity" },
		{ re: /jailbreak/i, name: "jailbreak_keyword" },
		{ re: /DAN\s+mode|developer\s+mode/i, name: "mode_override" },
		{ re: /forget\s+(?:everything|all|your)/i, name: "forget_instructions" },
		{
			re: /(?:reveal|show|output|print|display)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
			name: "prompt_extraction",
		},
		{
			re: /grant\s+(?:me\s+)?(?:admin|all\s+permissions|full\s+access|root)/i,
			name: "privilege_request",
		},
		{ re: /elevate\s+(?:my\s+)?privileges/i, name: "escalation_request" },
	];
	for (const { re, name } of injectionPatterns) {
		if (re.test(lower)) signals.push(name);
	}

	const sePatterns = [
		{
			re: /(?:urgent|emergency|critical).*(?:need|must|have\s+to|right\s+now)/i,
			name: "urgency_pressure",
		},
		{
			re: /(?:i\s+am|i'm)\s+(?:the|an?)\s+(?:admin|administrator|owner|manager|ceo|supervisor|director)/i,
			name: "authority_claim",
		},
		{ re: /(?:you\s+owe\s+me|return\s+the\s+favor)/i, name: "reciprocity" },
		{ re: /everyone\s+(?:else\s+)?(?:already\s+)?has/i, name: "social_proof" },
		{
			re: /(?:consequences|report\s+(?:this|you)\s+to|get\s+(?:you|me)\s+fired)/i,
			name: "intimidation",
		},
		{
			re: /(?:connect\s+your\s+wallet|claim\s+your\s+reward|airdrop|giveaway)/i,
			name: "scam_keywords",
		},
		{
			re: /verify\s+your\s+(?:identity|account|wallet)/i,
			name: "verification_scam",
		},
	];
	for (const { re, name } of sePatterns) {
		if (re.test(lower)) signals.push(name);
	}

	const isWarning = NEGATION_RE.test(text);
	if (!isWarning) {
		const credPatterns = [
			{
				re: /(?:send|share|give|post|tell|paste|reveal|provide)\s+(?:me\s+)?(?:your\s+)?(?:api.?(?:key|token)|password|credentials|seed\s+phrase|private\s+key|secret|recovery\s+phrase|2FA|login|\.env|ssh.*key|client.?secret)/i,
				name: "credential_request",
			},
			{ re: /(?:bit\.ly|tinyurl|t\.co)\/\S+/i, name: "shortened_url" },
		];
		for (const { re, name } of credPatterns) {
			if (re.test(lower)) signals.push(name);
		}
	}

	return signals;
}

// ─── Evaluator ──────────────────────────────────────────────────────────────

export const securityAction: Action = {
	name: "securityEvaluator",
	mode: ActionMode.ALWAYS_BEFORE,
	modePriority: 10,
	examples: [],

	description:
		"Pre-processing security gate that uses fast heuristics to detect prompt " +
		"injection, social engineering, credential theft, and other adversarial " +
		"inputs BEFORE they reach the agent. Blocked messages are never stored " +
		"in memory. No LLM calls -- purely pattern-based for speed and reliability.",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		if (message.entityId === runtime.agentId) return false;

		try {
			if (await resolveAdminContext(runtime, message, state)) {
				return false;
			}
		} catch (error) {
			logger.debug(
				{ error, entityId: message.entityId, roomId: message.roomId },
				"[SecurityEvaluator] Admin-context lookup failed; continuing with normal scanning",
			);
		}

		return true;
	},

	handler: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ActionResult | undefined> => {
		const text = message.content?.text || "";
		if (!text || text.length < 3) {
			return undefined;
		}

		const signals = detectHeuristicSignals(text);

		if (signals.length === 0) {
			return undefined;
		}

		logger.info(
			{ signals, messagePreview: text.slice(0, 80) },
			`[SecurityEvaluator] Heuristic signals: ${signals.join(", ")}`,
		);

		const hasHighConfidence = signals.some((s) =>
			HIGH_CONFIDENCE_SIGNALS.has(s),
		);

		if (hasHighConfidence) {
			const reason = `Security threat detected: ${signals.join(", ")}`;
			logger.warn(
				{ entityId: message.entityId, signals },
				"[SecurityEvaluator] Blocking message -- high-confidence threat signals",
			);
			return {
				success: false,
				text: reason,
				error: reason,
			};
		}

		logger.debug(
			{ signals },
			"[SecurityEvaluator] Low-confidence signals -- passing through to agent",
		);
		return undefined;
	},
};
