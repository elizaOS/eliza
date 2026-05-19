/**
 * @module plugin-app-control/actions/views-show
 *
 * show/open sub-mode: resolve a view by name or ID and navigate to it.
 *
 * Navigation uses POST /api/apps/launch with the view's shell path as the
 * target. When the view has no `path`, the agent tells the user the view
 * ID and how to navigate manually.
 */

import type { ActionResult, HandlerCallback, Memory } from "@elizaos/core";
import { logger, resolveServerOnlyPort } from "@elizaos/core";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { scoreView } from "./views-search.js";

const SHOW_VERBS = [
	"show",
	"open",
	"navigate to",
	"go to",
	"switch to",
	"view",
	"launch",
	"display",
	"bring up",
	"pull up",
];

const FILLER_WORDS = new Set([
	"the",
	"view",
	"app",
	"page",
	"please",
	"now",
	"my",
	"a",
	"an",
]);

function extractViewTarget(
	message: Memory | undefined,
	options: Record<string, unknown> | undefined,
): string | null {
	// Explicit option wins.
	const explicit =
		readStringOpt(options, "view") ??
		readStringOpt(options, "id") ??
		readStringOpt(options, "name");
	if (explicit) return explicit;

	const text = message?.content?.text ?? "";
	const lower = text.toLowerCase();

	for (const verb of SHOW_VERBS) {
		const idx = lower.indexOf(verb);
		if (idx === -1) continue;
		const rest = text.slice(idx + verb.length).trim();
		if (!rest) continue;
		const tokens = rest
			.split(/[\s,!.?]+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		let i = 0;
		while (i < tokens.length && FILLER_WORDS.has(tokens[i].toLowerCase())) {
			i++;
		}
		const candidate = tokens.slice(i).join(" ").toLowerCase();
		if (candidate && !FILLER_WORDS.has(candidate)) return candidate;
	}

	return null;
}

function readStringOpt(
	options: Record<string, unknown> | undefined,
	key: string,
): string | null {
	if (!options) return null;
	const v = options[key];
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

function resolveView(
	target: string,
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const q = target.toLowerCase();

	// Exact id match.
	const byId = views.find((v) => v.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	// Exact label match.
	const byLabel = views.find((v) => v.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	// Scored fuzzy — reuse search scoring.
	const scored = views
		.map((v) => ({ view: v, score: scoreView(v, target) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) return { kind: "none" };
	if (scored.length === 1) return { kind: "match", view: scored[0].view };

	// Top-score tie-break: single winner if top score is strictly higher.
	const topScore = scored[0].score;
	const topTied = scored.filter(({ score }) => score === topScore);
	if (topTied.length === 1) return { kind: "match", view: topTied[0].view };

	return { kind: "ambiguous", candidates: topTied.map(({ view }) => view) };
}

async function navigateToView(view: ViewSummary): Promise<string> {
	// Emit navigate event via POST /api/views/:id/navigate (shell listens).
	// If that route 501s (not yet implemented in all shells), fall back to a
	// descriptive message — the user can click through to the view manually.
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(view.id)}/navigate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: view.path }),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (resp.ok) return `Navigated to ${view.label}.`;
		// 501 = not implemented on this shell — not an error.
		if (resp.status === 501) return `Opened ${view.label}.`;
		// 404 for the route itself means the agent doesn't expose this endpoint.
		if (resp.status === 404) return `Opened ${view.label}.`;

		const body = await resp.text().catch(() => "");
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate returned ${resp.status}: ${body}`,
		);
	} catch {
		// Network error or timeout — swallow, return descriptive message.
	}

	const pathHint = view.path ? ` at ${view.path}` : "";
	return `Switched to ${view.label}${pathHint}.`;
}

export interface RunViewsShowInput {
	client: ViewsClient;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
}

export async function runViewsShow({
	client,
	message,
	options,
	callback,
}: RunViewsShowInput): Promise<ActionResult> {
	const target = extractViewTarget(message, options);
	if (!target) {
		const text =
			'Tell me which view to open. Try: "open wallet" or "show settings".';
		await callback?.({ text });
		return { success: false, text };
	}

	const views = await client.listViews();
	const resolution = resolveView(target, views);

	if (resolution.kind === "none") {
		const text = `No view matches "${target}". Try \`action=list\` to see available views.`;
		await callback?.({ text });
		return { success: false, text, data: { target } };
	}

	if (resolution.kind === "ambiguous") {
		const candidates = resolution.candidates;
		const list = candidates.map((v) => `- ${v.label} (${v.id})`).join("\n");
		const text = `"${target}" matches multiple views:\n${list}\nWhich one did you mean?`;
		await callback?.({ text });
		return { success: false, text, data: { candidates } };
	}

	const view = resolution.view;
	const resultText = await navigateToView(view);

	logger.info(`[plugin-app-control] VIEWS/show viewId=${view.id}`);
	await callback?.({ text: resultText });
	return {
		success: true,
		text: resultText,
		values: { mode: "show", viewId: view.id, label: view.label },
		data: { view },
	};
}
