/**
 * `/backend` — the default coding sub-agent backend as a slash surface over
 * the validated model-config API. Bare `/backend` reads the effective
 * ELIZA_DEFAULT_AGENT_TYPE from `GET /api/models/config`; `/backend <backend>`
 * persists it through the defaultBackend-only write of
 * `POST /api/models/config` (config.env + config.env.vars + process.env), so
 * the switch survives restarts — never `runtime.setSetting`, which is
 * in-memory only and silently reverts.
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import type { CommandResult, ParsedCommand } from "../types";
import { CODING_BACKEND_TOKENS, type CodingBackend } from "./model-config";

export type BackendCommand =
	| { kind: "show" }
	| { kind: "write"; backend: CodingBackend }
	| { kind: "usage"; error: string };

const BACKEND_TOKEN_LIST = Object.keys(CODING_BACKEND_TOKENS).join(", ");

const BACKEND_USAGE = `Usage: /backend [backend] — backend is one of ${BACKEND_TOKEN_LIST}.`;

function reply(text: string): CommandResult {
	return { handled: true, reply: text, shouldContinue: false };
}

/** Parse a `/backend` argument list: bare shows, one known token writes. */
export function parseBackendArgs(parsed: ParsedCommand): BackendCommand {
	const tokens = (parsed.rawArgs?.trim() || parsed.args.join(" ").trim())
		.split(/\s+/)
		.filter(Boolean);
	if (tokens.length === 0) return { kind: "show" };
	if (tokens.length > 1) return { kind: "usage", error: BACKEND_USAGE };
	const backend = CODING_BACKEND_TOKENS[(tokens[0] as string).toLowerCase()];
	if (!backend) {
		return {
			kind: "usage",
			error: `Unknown coding backend "${tokens[0]}". ${BACKEND_USAGE}`,
		};
	}
	return { kind: "write", backend };
}

type EffectiveValue = { value: string; source: string } | null;

interface ModelConfigShowResponse {
	targets?: Record<string, Record<string, EffectiveValue>>;
	error?: string;
}

/**
 * GET the effective model config and report just the coding-backend key: the
 * persisted value with the source that won, or its unset state.
 */
export async function runBackendShowViaRoute(): Promise<CommandResult> {
	const port = resolveServerOnlyPort(process.env);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${port}/api/models/config`, {
			method: "GET",
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		return reply(
			`Couldn't read the coding backend: ${err instanceof Error ? err.message : String(err)}.`,
		);
	}
	// error-policy:J3 non-JSON/empty response body -> null; handled as a route error.
	const parsed = (await response
		.json()
		.catch(() => null)) as ModelConfigShowResponse | null;
	if (!response.ok || !parsed?.targets) {
		return reply(
			`Couldn't read the coding backend: ${
				typeof parsed?.error === "string"
					? parsed.error
					: `route returned ${response.status}`
			}`,
		);
	}
	const effective = parsed.targets.coding?.ELIZA_DEFAULT_AGENT_TYPE ?? null;
	const current = effective
		? `${effective.value} (${effective.source})`
		: "not set — the orchestrator picks per task";
	return reply(
		[
			`Default coding backend: ${current}`,
			`Available: ${BACKEND_TOKEN_LIST}. Switch with /backend <backend>.`,
		].join("\n"),
	);
}
