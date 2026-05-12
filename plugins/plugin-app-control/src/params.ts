/**
 * @module plugin-app-control/params
 * @description Extract the target app identifier from action options or the
 * triggering user message. Scoped narrowly on purpose — the upstream
 * `@elizaos/agent` package has a richer i18n keyword system; this plugin
 * only needs to pick a single token after verbs like "launch" / "close".
 */

import type { Memory } from "@elizaos/core";

const LAUNCH_VERBS = [
	"launch",
	"open",
	"start",
	"run",
	"fire up",
	"boot",
	"show",
];

const CLOSE_VERBS = [
	"close",
	"stop",
	"exit",
	"quit",
	"kill",
	"shut down",
	"shutdown",
	"terminate",
];

const FILLER_WORDS = new Set([
	"the",
	"app",
	"application",
	"overlay",
	"mini",
	"please",
	"now",
	"my",
]);

function extractAfterVerbs(
	text: string,
	verbs: readonly string[],
): string | null {
	const lower = text.toLowerCase();
	for (const verb of verbs) {
		const idx = lower.indexOf(verb);
		if (idx === -1) continue;
		const afterIdx = idx + verb.length;
		const rest = text.slice(afterIdx).trim();
		if (!rest) continue;

		const tokens = rest
			.split(/[\s,!.?]+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);

		// Peel fillers off the front ("the", "app", etc.). Whatever remains
		// is the candidate name.
		let i = 0;
		while (i < tokens.length && FILLER_WORDS.has(tokens[i].toLowerCase())) {
			i += 1;
		}
		const candidate = tokens[i]?.toLowerCase();
		if (candidate && !FILLER_WORDS.has(candidate)) {
			return candidate;
		}
	}
	return null;
}

export interface AppControlOptions {
	app?: string;
	name?: string;
	runId?: string;
}

export function readStringOption(
	options: Record<string, unknown> | undefined,
	key: string,
): string | null {
	if (!options) return null;
	const value = options[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function extractLaunchTarget(
	message: Memory | undefined,
	options: Record<string, unknown> | undefined,
): string | null {
	return (
		readStringOption(options, "app") ??
		readStringOption(options, "name") ??
		extractAfterVerbs(message?.content?.text ?? "", LAUNCH_VERBS)
	);
}

export function extractCloseTarget(
	message: Memory | undefined,
	options: Record<string, unknown> | undefined,
): { runId: string | null; appName: string | null } {
	const runId = readStringOption(options, "runId");
	const appName =
		readStringOption(options, "app") ??
		readStringOption(options, "name") ??
		extractAfterVerbs(message?.content?.text ?? "", CLOSE_VERBS);
	return { runId, appName };
}
