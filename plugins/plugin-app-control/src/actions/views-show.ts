/**
 * Resolves a requested view and asks the active shell to navigate to it.
 * The action returns an internal effect receipt after the shell accepts the
 * navigation; the post-tool model owns all visible wording.
 */

import { randomUUID } from "node:crypto";
import type {
	ActionResult,
	HandlerCallback,
	Memory,
	ViewType,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";
import { resolveSettingsSectionToken } from "@elizaos/ui/components/settings/settings-section-tokens";
import { getAppControlApiBase } from "../loopback-api.js";
import { describeTargetReference, targetReferenceLogView } from "../params.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";
import { scoreView } from "./views-search.js";

const DOCUMENT_SURFACE_WORDS =
	/\b(?:documents?|docs?|files?|knowledge|uploads?|retrieval|papers?)\b/i;

function isRealtimeVoiceTurn(message: Memory): boolean {
	const metadata = message.content.metadata;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		!Array.isArray(metadata) &&
		(metadata as Record<string, unknown>).clientTransport ===
			REALTIME_VOICE_CLIENT_TRANSPORT
	);
}
const NOTES_SURFACE_WORD = /\bnotes?\b/i;

export function isStandaloneNotesSurfaceRequest(text: string): boolean {
	return NOTES_SURFACE_WORD.test(text) && !DOCUMENT_SURFACE_WORDS.test(text);
}

function extractViewTarget(
	options: Record<string, unknown> | undefined,
): string | null {
	// Explicit option wins. Accept every alias the VIEWS schema + the other
	// sub-modes accept (view/viewId/id/target/name) so a planner-supplied
	// `{ action: "show", target: "settings" }` or `{ viewId: "settings" }`
	// resolves instead of dead-ending on the text scan.
	const explicit =
		readStringOpt(options, "view") ??
		readStringOpt(options, "viewId") ??
		readStringOpt(options, "id") ??
		readStringOpt(options, "target") ??
		readStringOpt(options, "name");
	if (explicit) return explicit;

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

/** @deprecated Natural-language view selection is model-owned. */
export const INTENT_VIEW_IDS: readonly string[] = [];

/** @deprecated Natural-language view selection is model-owned. */
export function resolveIntentView(_text: string | undefined): null {
	return null;
}

function resolveView(
	target: string,
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	// `home` is the platform-level name for the canonical chat Workspace. The
	// planner owns the intent and supplies this structured target; the action
	// boundary owns translating that stable product alias to the registry id.
	const requested = target.toLowerCase();
	const q = requested === "home" ? "chat" : requested;

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

/**
 * Resolve a semantic intent to the view that owns the connector-independent
 * experience in the current registry. The connected Calendar remains
 * addressable by its exact id and is the fallback when Simple Calendar is not
 * installed; when both exist, a generic spoken calendar request should open the
 * durable view that works without a connector.
 */
interface NavigateResult {
	ok: boolean;
	/** Internal tool receipt for post-tool reasoning; never assistant prose. */
	text: string;
	/** Resolved sub-section the renderer was asked to focus (settings only). */
	subview?: string;
	/** The server synchronously accepted delivery to the originating renderer. */
	completedActionDelivered?: true;
	/** Renderer-observed idempotency key echoed by a supporting server. */
	completedActionHandoffId?: string;
}

function navigationEffectReceipt({
	status,
	view,
	navigationLabel,
	subview,
}: {
	status: "accepted" | "unsupported-route" | "unconfirmed";
	view: ViewSummary;
	navigationLabel: string;
	subview?: string;
}): string {
	return JSON.stringify({
		effect: "view_navigation",
		status,
		viewId: view.id,
		label: navigationLabel,
		...(view.path ? { path: view.path } : {}),
		...(subview ? { subview } : {}),
	});
}

/** Accept only the own, literal confirmation field emitted by the agent route. */
function confirmsCompletedActionDelivery(body: unknown): boolean {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return false;
	}
	return (
		Object.getOwnPropertyDescriptor(body, "completedActionDelivered")?.value ===
		true
	);
}

/**
 * Resolve a caller-supplied sub-section token into the value the renderer
 * focuses. Settings is the only view with addressable sub-sections today, so we
 * reuse the canonical client token→section-id map (`resolveSettingsSectionToken`)
 * rather than inventing a second mapping. An unknown token for the settings view
 * (or any token for another view) is passed through verbatim — the renderer
 * applies the same resolution and ignores values it doesn't recognize.
 */
function resolveSubviewForView(
	view: ViewSummary,
	subview: string | undefined,
): string | undefined {
	const token = subview?.trim();
	if (!token) return undefined;
	if (view.id === "settings") {
		return resolveSettingsSectionToken(token) ?? token.toLowerCase();
	}
	return token;
}

async function navigateToView(
	view: ViewSummary,
	requestedViewType?: ViewType,
	subview?: string,
	navigationLabel = view.label,
	delivery?: "originating-client" | "completed-action",
	originatingClientId?: string,
	completedActionHandoffId?: string,
): Promise<NavigateResult> {
	// Emit navigate event via POST /api/views/:id/navigate (shell listens).
	// A shell without the navigate route did not accept the requested effect.
	// Keep 404/501 distinct in the internal receipt, but never claim success or
	// request a model-authored acknowledgement for an effect that did not occur.
	// A real transport failure (other non-2xx, network, timeout) is also NOT success:
	// reporting "Switched to X" when nothing happened misleads the user and the
	// chain's verifiedUserFacing logic.
	const base = getAppControlApiBase();
	const resolvedSubview = resolveSubviewForView(view, subview);

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(view.id)}/navigate${requestedViewType ? `?viewType=${requestedViewType}` : ""}`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({
					path: view.path,
					viewType: requestedViewType,
					...(resolvedSubview ? { subview: resolvedSubview } : {}),
					...(delivery ? { delivery } : {}),
					...(originatingClientId ? { clientId: originatingClientId } : {}),
					...(completedActionHandoffId ? { completedActionHandoffId } : {}),
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (resp.ok) {
			let responseBody: unknown;
			try {
				responseBody = await resp.json();
			} catch (error) {
				// error-policy:J3 malformed optional receipt JSON keeps the terminal
				// navigation fallback enabled; transport/body failures remain failures.
				if (!(error instanceof SyntaxError)) throw error;
				responseBody = null;
			}
			const echoedCompletedActionHandoffId =
				completedActionHandoffId &&
				typeof responseBody === "object" &&
				responseBody !== null &&
				!Array.isArray(responseBody) &&
				Object.getOwnPropertyDescriptor(
					responseBody,
					"completedActionHandoffId",
				)?.value === completedActionHandoffId
					? completedActionHandoffId
					: undefined;
			return {
				ok: true,
				text: navigationEffectReceipt({
					status: "accepted",
					view,
					navigationLabel,
					subview: resolvedSubview,
				}),
				subview: resolvedSubview,
				...(delivery === "completed-action" &&
				confirmsCompletedActionDelivery(responseBody) &&
				(!completedActionHandoffId || echoedCompletedActionHandoffId)
					? { completedActionDelivered: true as const }
					: {}),
				...(echoedCompletedActionHandoffId
					? { completedActionHandoffId: echoedCompletedActionHandoffId }
					: {}),
			};
		}
		// Preserve the unsupported-route diagnosis without fabricating success.
		if (resp.status === 501 || resp.status === 404)
			return {
				ok: false,
				text: navigationEffectReceipt({
					status: "unsupported-route",
					view,
					navigationLabel,
					subview: resolvedSubview,
				}),
				subview: resolvedSubview,
			};

		const body = await resp.text().catch(() => "");
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate returned ${resp.status}: ${body}`,
		);
	} catch (err) {
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		ok: false,
		text: navigationEffectReceipt({
			status: "unconfirmed",
			view,
			navigationLabel,
			subview: resolvedSubview,
		}),
	};
}

export interface RunViewsShowInput {
	client: ViewsClient;
	message: Memory;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
	originatingClientId?: string;
}

export async function runViewsShow({
	client,
	message,
	options,
	viewType,
	originatingClientId,
}: RunViewsShowInput): Promise<ActionResult> {
	const target = extractViewTarget(options);
	if (!target) {
		const text =
			"VIEWS requires a structured view id or label for action=show.";
		return {
			success: false,
			text,
			transcriptVisibility: "internal",
			turnComplete: false,
		};
	}

	const views = await client.listViews({ viewType });
	const resolution = resolveView(target, views);

	if (resolution.kind === "none") {
		const text = `No view matches ${describeTargetReference(target)}. Try \`action=list\` to see available views.`;
		return {
			success: false,
			text,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: { target: targetReferenceLogView(target) },
		};
	}

	if (resolution.kind === "ambiguous") {
		const candidates = resolution.candidates;
		const list = candidates.map((v) => `- ${v.label} (${v.id})`).join("\n");
		const text = `${describeTargetReference(target)} matches multiple views:\n${list}\nWhich one did you mean?`;
		return {
			success: false,
			text,
			transcriptVisibility: "internal",
			turnComplete: false,
			data: { candidates },
		};
	}

	const view = resolution.view;
	const subview =
		readStringOpt(options, "subview") ?? readStringOpt(options, "section");
	const navigationLabel =
		target.trim().toLowerCase() === "home" ? "Home" : view.label;
	const completedActionDelivery =
		!isRealtimeVoiceTurn(message) && Boolean(originatingClientId);
	const completedActionHandoffId = completedActionDelivery
		? randomUUID()
		: undefined;
	const result = await navigateToView(
		view,
		viewType,
		subview ?? undefined,
		navigationLabel,
		!completedActionDelivery && isRealtimeVoiceTurn(message)
			? "originating-client"
			: completedActionDelivery
				? "completed-action"
				: undefined,
		originatingClientId,
		completedActionHandoffId,
	);

	logger.info(
		`[plugin-app-control] VIEWS/show viewId=${view.id} viewType=${view.viewType ?? "gui"}${result.subview ? ` subview=${result.subview}` : ""}`,
	);
	return {
		success: result.ok,
		text: result.text,
		// Navigation has already been handed to the shell. A confirmed success
		// requests exactly one post-tool model reply so the acknowledgement stays
		// natural and model-owned without an evaluator/planner retry loop. Failed or
		// unconfirmed navigation retains full evaluation and recovery.
		transcriptVisibility: "internal",
		...(result.ok
			? {
					modelReplyRequired: true,
				}
			: { turnComplete: false }),
		values: {
			mode: "show",
			viewId: view.id,
			...(view.path ? { viewPath: view.path } : {}),
			viewType: view.viewType ?? viewType ?? "gui",
			label: navigationLabel,
			...(result.subview ? { subview: result.subview } : {}),
			...(confirmsCompletedActionDelivery(result)
				? { completedActionDelivered: true }
				: {}),
			...(result.completedActionHandoffId
				? { completedActionHandoffId: result.completedActionHandoffId }
				: {}),
		},
		data: { view, ...(result.subview ? { subview: result.subview } : {}) },
	};
}
