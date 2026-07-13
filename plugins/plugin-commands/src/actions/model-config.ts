/**
 * `/model small|large|coding|show` — the slash surface over the validated
 * model-config API (`packages/agent/src/api/model-config-routes.ts`). The
 * command handler never validates model/effort values itself: it parses the
 * token shape, then drives the same loopback route every other client uses, so
 * the catalog-backed 400s (which name the supported efforts) surface verbatim.
 *
 * Token grammar, chosen so it can never collide with the two pre-existing
 * `/model` behaviors (`local|cloud [id]` runtime switch, bare-name per-room
 * preference):
 *   /model show
 *   /model small|large [provider] <model> [effort]     provider ∈ chat providers,
 *                                                      or fused as provider/model
 *   /model coding <backend> <model> [effort]           backend ∈ coding backends
 * Anything else returns null from the parser and falls through to the existing
 * paths in handlers.ts.
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import type { CommandResult, ParsedCommand } from "../types";

/** Chat providers accepted by POST /api/models/config for small/large. */
const CHAT_PROVIDERS = ["cerebras", "elizacloud", "claude-chat"] as const;
type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/** Coding backends accepted by POST /api/models/config for target "coding". */
export type CodingBackend = "codex" | "claude" | "opencode" | "eliza-code";

// "elizaos" is the orchestrator's spelling of the in-house backend (and what
// ELIZA_DEFAULT_AGENT_TYPE persists); the API literal is "eliza-code" and the
// user-facing name is "eliza". Shared with `/backend` (backend.ts) so both
// commands accept the same tokens.
export const CODING_BACKEND_TOKENS: Record<string, CodingBackend> = {
	codex: "codex",
	claude: "claude",
	opencode: "opencode",
	eliza: "eliza-code",
	"eliza-code": "eliza-code",
	elizaos: "eliza-code",
};

/**
 * One user-facing name per OFFERED backend, for display strings. The token
 * map above is the INPUT surface (aliases welcome — including "opencode",
 * which stays switchable by name but is deliberately not offered in lists
 * and pickers; owner decision, 2026-07-13).
 */
export const CODING_BACKEND_DISPLAY: readonly string[] = [
	"codex",
	"claude",
	"eliza",
];

/** Map a persisted wire value (e.g. "elizaos") to its user-facing name. */
export function displayCodingBackend(value: string): string {
	return value === "elizaos" || value === "eliza-code" ? "eliza" : value;
}

export interface ModelConfigWriteBody {
	target: "small" | "large" | "coding";
	provider?: ChatProvider;
	backend?: CodingBackend;
	/** Omitted only for the defaultBackend-only coding switch (`/backend`). */
	model?: string;
	effort?: string;
	/** Coding-backend switch, persisted as ELIZA_DEFAULT_AGENT_TYPE. */
	defaultBackend?: CodingBackend;
}

export type ModelConfigCommand =
	| { kind: "show" }
	| { kind: "write"; body: ModelConfigWriteBody }
	| { kind: "usage"; error: string };

function reply(text: string): CommandResult {
	return { handled: true, reply: text, shouldContinue: false };
}

function isChatProvider(token: string): token is ChatProvider {
	return (CHAT_PROVIDERS as readonly string[]).includes(token);
}

function chatUsage(target: "small" | "large"): string {
	return `Usage: /model ${target} [provider] <model> [effort] — provider is one of ${CHAT_PROVIDERS.join(", ")} (needed only when the model is served by more than one).`;
}

const CODING_USAGE = `Usage: /model coding <backend> <model> [effort] — backend is one of ${CODING_BACKEND_DISPLAY.join(", ")}.`;

/**
 * Parse a `/model` argument list into a model-config command. Returns null when
 * the first token is not one of the config subcommands (`show`, `small`,
 * `large`, `coding`), so the caller keeps the runtime-switch and per-room
 * preference behaviors untouched.
 */
export function parseModelConfigArgs(
	parsed: ParsedCommand,
): ModelConfigCommand | null {
	const tokens = (parsed.rawArgs?.trim() || parsed.args.join(" ").trim())
		.split(/\s+/)
		.filter(Boolean);
	const first = tokens[0]?.toLowerCase();

	if (first === "show") {
		if (tokens.length > 1) {
			return { kind: "usage", error: "Usage: /model show" };
		}
		return { kind: "show" };
	}

	if (first === "small" || first === "large") {
		const rest = tokens.slice(1);
		let provider: ChatProvider | undefined;
		if (rest[0] && isChatProvider(rest[0].toLowerCase())) {
			provider = rest.shift()?.toLowerCase() as ChatProvider;
		}
		let model = rest.shift();
		if (model && provider === undefined) {
			// Fused provider/model form ("cerebras/zai-glm-4.7") — split only when
			// the prefix names a chat provider, so a slashed model id such as
			// "openai/gpt-oss-120b" stays a model id.
			const slash = model.indexOf("/");
			const prefix = slash > 0 ? model.slice(0, slash).toLowerCase() : "";
			if (isChatProvider(prefix)) {
				provider = prefix;
				model = model.slice(slash + 1);
			}
		}
		if (!model) return { kind: "usage", error: chatUsage(first) };
		const effort = rest.shift();
		if (rest.length > 0) return { kind: "usage", error: chatUsage(first) };
		return {
			kind: "write",
			body: {
				target: first,
				model,
				...(provider ? { provider } : {}),
				...(effort ? { effort } : {}),
			},
		};
	}

	if (first === "coding") {
		const backendToken = tokens[1]?.toLowerCase();
		if (!backendToken) return { kind: "usage", error: CODING_USAGE };
		const backend = CODING_BACKEND_TOKENS[backendToken];
		if (!backend) {
			return {
				kind: "usage",
				error: `Unknown coding backend "${tokens[1]}". ${CODING_USAGE}`,
			};
		}
		const model = tokens[2];
		if (!model) return { kind: "usage", error: CODING_USAGE };
		const effort = tokens[3];
		if (tokens.length > 4) return { kind: "usage", error: CODING_USAGE };
		return {
			kind: "write",
			body: {
				target: "coding",
				backend,
				model,
				...(effort ? { effort } : {}),
			},
		};
	}

	return null;
}

interface ModelConfigWriteResponse {
	applied?: boolean;
	restart?: boolean;
	operationId?: string;
	keys?: string[];
	deduped?: boolean;
	conflictingServiceEnvKeys?: string[];
	error?: string;
	activeOperationId?: string;
}

function describeWrite(body: ModelConfigWriteBody): string {
	const effort = body.effort ? ` at ${body.effort} effort` : "";
	if (body.target === "coding") {
		if (body.model === undefined) {
			return `Default coding backend set to ${displayCodingBackend(body.defaultBackend ?? "")}`;
		}
		return `Coding model for ${displayCodingBackend(body.backend ?? "")} set to ${body.model}${effort}`;
	}
	const provider = body.provider ? ` (${body.provider})` : "";
	return `${body.target === "small" ? "Small" : "Large"} chat model set to ${body.model}${provider}${effort}`;
}

/**
 * POST the validated model-config route with a parsed write. Success replies
 * state whether a restart applies the change; a 400's message is passed through
 * verbatim (the route's errors name the supported models/efforts/providers).
 */
export async function runModelConfigWriteViaRoute(
	body: ModelConfigWriteBody,
): Promise<CommandResult> {
	const port = resolveServerOnlyPort(process.env);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${port}/api/models/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		return reply(
			`Couldn't update the model config: ${err instanceof Error ? err.message : String(err)}.`,
		);
	}
	// error-policy:J3 non-JSON/empty response body -> null; the caller reads
	// response.ok / fields defensively, so an unparseable body is a handled shape.
	const parsed = (await response
		.json()
		.catch(() => null)) as ModelConfigWriteResponse | null;
	if (response.status === 409) {
		const active = parsed?.activeOperationId
			? ` (operation ${parsed.activeOperationId})`
			: "";
		return reply(
			`Couldn't update the model config: a runtime operation is already in progress${active}. Try again once it finishes.`,
		);
	}
	if (!response.ok || parsed?.applied !== true) {
		return reply(
			`Couldn't update the model config: ${
				typeof parsed?.error === "string"
					? parsed.error
					: `route returned ${response.status}`
			}`,
		);
	}

	const lines = [
		parsed.restart
			? `${describeWrite(body)} — restarting the agent to apply.`
			: `${describeWrite(body)} — applies to new coding sessions, no restart needed.`,
	];
	if (body.effort && parsed.keys?.includes("OPENAI_REASONING_EFFORT")) {
		lines.push(
			"Note: OPENAI_REASONING_EFFORT is shared by the small and large chat targets.",
		);
	}
	if (parsed.conflictingServiceEnvKeys?.length) {
		lines.push(
			`Warning: ${parsed.conflictingServiceEnvKeys.join(", ")} also carried a service-environment value; a full service restart may restore it.`,
		);
	}
	return reply(lines.join("\n"));
}

type EffectiveValue = {
	value: string;
	source: string;
} | null;

interface ModelConfigShowResponse {
	targets?: Record<string, Record<string, EffectiveValue>>;
	error?: string;
}

const SHOW_TARGET_ORDER = ["small", "large", "coding"] as const;

/**
 * GET the effective model config and format it as one reply: every key the
 * config route owns, with the source that won (config.env / config.env.vars /
 * process.env / default) or `unset`.
 */
export async function runModelConfigShowViaRoute(): Promise<CommandResult> {
	const port = resolveServerOnlyPort(process.env);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${port}/api/models/config`, {
			method: "GET",
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		return reply(
			`Couldn't read the model config: ${err instanceof Error ? err.message : String(err)}.`,
		);
	}
	// error-policy:J3 non-JSON/empty response body -> null; handled as a route error.
	const parsed = (await response
		.json()
		.catch(() => null)) as ModelConfigShowResponse | null;
	if (!response.ok || !parsed?.targets) {
		return reply(
			`Couldn't read the model config: ${
				typeof parsed?.error === "string"
					? parsed.error
					: `route returned ${response.status}`
			}`,
		);
	}

	const lines = ["Model configuration:"];
	for (const target of SHOW_TARGET_ORDER) {
		const keys = parsed.targets[target];
		if (!keys) continue;
		lines.push(`**${target}**`);
		for (const [key, effective] of Object.entries(keys)) {
			lines.push(
				effective
					? `  ${key} = ${effective.value} (${effective.source})`
					: `  ${key} unset`,
			);
		}
	}
	return reply(lines.join("\n"));
}
