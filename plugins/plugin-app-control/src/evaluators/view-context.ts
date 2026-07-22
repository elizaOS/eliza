/**
 * Evaluator that maps user context to registered views and dispatches navigation.
 */

import type {
	Evaluator,
	EvaluatorProcessor,
	EvaluatorRunContext,
	Memory,
} from "@elizaos/core";
import {
	getUserMessageText,
	logger,
	ModelType,
	resolveOptimizedPromptForRuntime,
} from "@elizaos/core";
import { VIEW_SCOPE_IDLE_TTL_MS } from "@elizaos/shared";
import {
	createViewsClient,
	getCurrentViewSnapshot,
	readViewClientId,
} from "../actions/views-client.js";
import {
	resolveIntentView,
	resolveNavigationView,
} from "../actions/views-show.js";

const VIEWS_ACTION_NAME = "VIEWS";
const NONE = "none";

interface ViewTurnStamp {
	key: string;
	createdAt: number;
	clientScope: string;
}

const DEFAULT_VIEW_TURN_SCOPE = "__default__";
const MAX_VIEW_TURN_SCOPES = 256;
const latestViewTurns = new Map<
	string,
	{
		/** Null means two accepted messages shared one millisecond and neither owns it. */
		key: string | null;
		createdAt: number;
		observedAt: number;
	}
>();

function pruneViewTurns(now: number): void {
	for (const [scope, owner] of latestViewTurns) {
		if (now - owner.observedAt >= VIEW_SCOPE_IDLE_TTL_MS) {
			latestViewTurns.delete(scope);
		}
	}
	while (latestViewTurns.size >= MAX_VIEW_TURN_SCOPES) {
		const oldestScope = latestViewTurns.keys().next().value;
		if (typeof oldestScope !== "string") return;
		latestViewTurns.delete(oldestScope);
	}
}

function viewTurnKey(message: Memory): string {
	if (message.id) return String(message.id);
	return `${message.createdAt ?? "unknown"}:${getUserMessageText(message)}`;
}

/**
 * Record ownership from the message timestamp assigned when the turn entered
 * the runtime, rather than from evaluator invocation order. Each renderer owns
 * an independent view surface, so only turns from that same client compete.
 * Missing or tied timestamps fail closed: contextual navigation is optional
 * and must never guess which of two turns is newer.
 */
function observeViewTurn(message: Memory): ViewTurnStamp | null {
	const createdAt =
		typeof message.createdAt === "number" &&
		Number.isSafeInteger(message.createdAt) &&
		message.createdAt >= 0
			? message.createdAt
			: null;
	if (createdAt === null) return null;

	const observedAt = Date.now();
	pruneViewTurns(observedAt);
	const key = viewTurnKey(message);
	const clientScope = readViewClientId(message) ?? DEFAULT_VIEW_TURN_SCOPE;
	const latestViewTurn = latestViewTurns.get(clientScope);
	const candidate = { key, createdAt, clientScope };
	if (!latestViewTurn || createdAt > latestViewTurn.createdAt) {
		latestViewTurns.delete(clientScope);
		latestViewTurns.set(clientScope, { key, createdAt, observedAt });
	} else if (
		createdAt === latestViewTurn.createdAt &&
		latestViewTurn.key !== key
	) {
		latestViewTurns.delete(clientScope);
		latestViewTurns.set(clientScope, { key: null, createdAt, observedAt });
	} else {
		latestViewTurn.observedAt = observedAt;
		latestViewTurns.delete(clientScope);
		latestViewTurns.set(clientScope, latestViewTurn);
	}
	return candidate;
}

function isLatestViewTurn(turn: ViewTurnStamp | null): boolean {
	const latestViewTurn = turn
		? latestViewTurns.get(turn.clientScope)
		: undefined;
	return (
		turn !== null &&
		latestViewTurn?.key === turn.key &&
		latestViewTurn.createdAt === turn.createdAt
	);
}

function turnRanViewsAction(state: EvaluatorRunContext["state"]): boolean {
	return (
		state?.data.actionResults?.some((result) => {
			const actionName = result.data?.actionName;
			return (
				typeof actionName === "string" &&
				actionName.trim().toUpperCase() === VIEWS_ACTION_NAME
			);
		}) ?? false
	);
}

// The user-facing domain surfaces a situation can map to. Kept as a fixed enum
// so the model output is constrained; the processor still confirms the id is an
// actually-registered view before navigating. Exported so the cross-list drift
// guard (#8797) can assert every contextual view is also matcher-resolvable.
export const CONTEXT_VIEWS = [
	"calendar",
	"inbox",
	"wallet",
	"finances",
	"todos",
	"goals",
	"health",
	"documents",
	"relationships",
	"focus",
	"task-coordinator",
] as const;

// Cheap pre-filter: only spend an LLM judgment when the turn plausibly involves
// an activity that maps to a surface. Greetings / acks / generic trivia never
// trip this, so the evaluator does not add a model section on every message.
// Stem + \w* (anchored at word start) so plurals/inflections match
// ("meeting(s)", "distract(ed)", "work(ing)", "schedul(ing)", "financ(es)").
// Word-start anchoring keeps "network"/"homework" from tripping "work". This is
// only a cheap pre-filter — over-matching just means the model judges and may
// return "none"; under-matching would silently skip a real situation.
const ACTIVITY_HINT_RE =
	/\b(cod\w*|build\w*|develop\w*|feature\w*|bug\w*|fix\w*|deploy\w*|apps?\b|plugin\w*|refactor\w*|implement\w*|ship\w*|meet\w*|appointment\w*|schedul\w*|event\w*|remind\w*|deadline\w*|e-?mail\w*|message\w*|inbox\w*|repl\w*|wallet\w*|balance\w*|crypto\w*|token\w*|portfolio\w*|spend\w*|spent\b|budget\w*|money\b|financ\w*|expense\w*|subscription\w*|task\w*|todo\w*|to-do\w*|checklist\w*|goal\w*|routine\w*|habit\w*|focus\w*|concentrat\w*|distract\w*|sleep\w*|health\w*|workout\w*|work\w*|step\w*|document\w*|file\w*|note\w*|contact\w*|relationship\w*|network\w*|colleague\w*|client\w*)/i;

export interface ViewContextOutput {
	viewId: string;
	reason?: string;
}

/**
 * The optimizable INSTRUCTION half of the evaluator prompt (the per-turn user
 * message is appended after it). This is the GEPA target for the `view_context`
 * task — an optimized artifact under `<state>/optimized-prompts/view_context/`
 * replaces it at runtime via {@link resolveOptimizedPromptForRuntime}. Exported
 * so the GEPA harness can optimize against the exact baseline.
 */
export const BASELINE_VIEW_CONTEXT_INSTRUCTION = [
	"Decide whether proactively opening ONE app view would clearly help the user right now, based on the situation/activity in their message.",
	`Available views: ${CONTEXT_VIEWS.join(", ")}.`,
	"Mapping guide:",
	"- writing / fixing / building code, app features, bugs, plugins → task-coordinator",
	"- meetings / appointments / scheduling / deadlines → calendar",
	"- email or messages to read/triage/reply → inbox",
	"- balances / crypto / tokens / portfolio → wallet",
	"- spending / budget / expenses / subscriptions → finances",
	"- tasks / to-dos / checklists → todos",
	"- goals / routines / habits → goals",
	"- sleep / workouts / health metrics → health",
	"- documents / files → documents",
	"- contacts / people / relationships → relationships",
	"- needing to concentrate / block distractions → focus",
	'- notes → "none" unless a registered Notes view is explicitly available through the VIEWS action',
	'If no view clearly helps (small talk, a question you can simply answer, or ambiguous intent), return viewId "none".',
	'Respond as JSON: {"viewId": <one listed view or "none">, "reason": <short>}.',
].join("\n");

/**
 * Navigate the shell to the situation-inferred view. Confirms the view is real
 * (registered) and not already active before firing the loopback navigate, so a
 * model hallucination or a no-op never moves the user.
 */
const navigateToContextualView: EvaluatorProcessor<ViewContextOutput> = {
	name: "navigate-to-contextual-view",
	async process({ output, message, runtime }) {
		const turn = observeViewTurn(message);
		if (!turn || !isLatestViewTurn(turn)) return undefined;
		const viewId =
			typeof output?.viewId === "string"
				? output.viewId.trim().toLowerCase()
				: "";
		if (!viewId || viewId === NONE) return undefined;

		const clientId = readViewClientId(message);
		const client = createViewsClient({ clientId });
		let startingViewRevision: number;
		try {
			const startingSnapshot = await getCurrentViewSnapshot(clientId);
			startingViewRevision = startingSnapshot.revision;
			if (startingSnapshot.currentView?.viewId === viewId) return undefined;
		} catch (error) {
			// error-policy:J7 post-response navigation diagnostics must not fail the
			// completed chat turn, but the agent must still observe the broken boundary.
			runtime.reportError("app-control.view-context.current-view", error, {
				phase: "before-discovery",
				viewId,
			});
			return undefined;
		}
		if (!isLatestViewTurn(turn)) return undefined;

		let views: Awaited<ReturnType<typeof client.listViews>>;
		try {
			views = await client.listViews();
		} catch (error) {
			// error-policy:J7 post-response navigation diagnostics must not fail the
			// completed chat turn, but the agent must still observe the broken boundary.
			runtime.reportError("app-control.view-context.list-views", error, {
				viewId,
			});
			return undefined;
		}
		const resolution = resolveNavigationView(viewId, views);
		if (resolution.kind !== "match") return undefined;
		const target = resolution.view;
		if (!isLatestViewTurn(turn)) return undefined;

		try {
			const currentSnapshot = await getCurrentViewSnapshot(clientId);
			if (currentSnapshot.currentView?.viewId === target.id) return undefined;
			// A navigation completed while the contextual classifier was pending.
			// Treat that newer shell state as authoritative even if its post-turn
			// evaluator has not reached `shouldRun` to advance the watermark yet.
			if (currentSnapshot.revision !== startingViewRevision) {
				return undefined;
			}
		} catch (error) {
			// error-policy:J7 fail closed when ownership cannot be revalidated; an
			// unverified post-response navigation could overwrite a newer user intent.
			runtime.reportError("app-control.view-context.current-view", error, {
				phase: "before-navigation",
				viewId,
			});
			return undefined;
		}
		if (!isLatestViewTurn(turn)) return undefined;

		const ok = await client.navigate(target.id, {
			path: target.path,
			viewType: target.viewType,
			expectedRevision: startingViewRevision,
		});
		if (!ok) return undefined;
		logger.info(
			`[plugin-app-control] contextual view nav → ${target.id}${output.reason ? ` (${output.reason})` : ""}`,
		);
		return { success: true, values: { contextualView: target.id } };
	},
};

/**
 * View switching as a post-response EVALUATOR (separate from the VIEWS action).
 *
 * The VIEWS action handles DIRECT commands the agent plans ("open my calendar")
 * — resolved deterministically by resolveIntentView, no model judgment needed.
 * This evaluator handles the CONTEXTUAL case the keyword resolver can't: the
 * user's situation implies a surface they never named — "fix the login bug" →
 * task-coordinator, "I've got back-to-back meetings" → calendar, "trying to cut
 * my spending" → finances. It runs after the reply, judges the situation with
 * the model (one merged evaluator call; mock it in tests), and a processor opens
 * the view. It deliberately defers to the action: shouldRun bails when
 * resolveIntentView already matches a direct surface, so the two never contend.
 */
export const viewContextEvaluator: Evaluator<ViewContextOutput> = {
	name: "app-control.view-context",
	description:
		"Proactively opens the app view that fits the user's current situation when they did not directly name one (e.g. coding work → task-coordinator). Separate from the VIEWS action, which handles direct navigation commands.",
	// Contextual view inference is a cheap classification — run it on the small
	// model. (The post-turn EvaluatorService currently routes the whole merged
	// call to TEXT_SMALL; this records intent + future-proofs per-evaluator
	// model selection.)
	modelType: ModelType.TEXT_SMALL,
	priority: 60,
	providers: ["RECENT_MESSAGES"],
	schema: {
		type: "object",
		properties: {
			viewId: { type: "string", enum: [...CONTEXT_VIEWS, NONE] },
			reason: { type: "string" },
		},
		required: ["viewId"],
	},
	async shouldRun({ runtime, message, state, options }) {
		// Observe every turn, including explicit commands that return false below.
		// That makes a newer deterministic VIEWS command supersede any slower
		// contextual classifier still finishing for the previous turn.
		const turn = observeViewTurn(message);
		if (!turn || !isLatestViewTurn(turn)) return false;
		if (options?.didRespond === false) return false;
		// Must be a view-capable app surface (VIEWS registered).
		const hasViews = (runtime.actions ?? []).some(
			(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
		);
		if (!hasViews) return false;
		// A VIEWS action attempt owns shell intent for this turn. Post-response
		// contextual inference must not follow a deliberate split/tile/navigation
		// (or reinterpret its explicit failure) with a second one-view navigation.
		if (turnRanViewsAction(state)) return false;
		const text = getUserMessageText(message);
		if (text.trim().length < 8) return false;
		// Direct nav commands belong to the VIEWS action — only infer contextually
		// when the keyword resolver finds NO direct surface but the turn hints at a
		// mappable activity.
		if (resolveIntentView(text)) return false;
		return ACTIVITY_HINT_RE.test(text);
	},
	prompt({ runtime, message }) {
		const text = getUserMessageText(message);
		// The instruction half is the GEPA-optimizable `view_context` prompt; the
		// per-turn user message is appended after it.
		const instruction = resolveOptimizedPromptForRuntime(
			runtime,
			"view_context",
			BASELINE_VIEW_CONTEXT_INSTRUCTION,
		);
		return `${instruction}\nUser message: ${JSON.stringify(text)}`;
	},
	parse(output) {
		if (!output || typeof output !== "object") return null;
		const rec = output as Record<string, unknown>;
		const viewId =
			typeof rec.viewId === "string" ? rec.viewId.trim().toLowerCase() : "";
		const allowed = new Set<string>([...CONTEXT_VIEWS, NONE]);
		if (!allowed.has(viewId)) return null;
		return {
			viewId,
			reason: typeof rec.reason === "string" ? rec.reason : undefined,
		};
	},
	processors: [navigateToContextualView],
};
