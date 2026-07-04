/**
 * Evaluator that maps user context to registered views and dispatches navigation.
 */

import type { Evaluator, EvaluatorProcessor } from "@elizaos/core";
import {
	logger,
	ModelType,
	resolveOptimizedPromptForRuntime,
} from "@elizaos/core";
import { createViewsClient } from "../actions/views-client.js";
import {
	isStandaloneNotesSurfaceRequest,
	resolveIntentView,
} from "../actions/views-show.js";
import { markViewSwitch } from "../runtime/view-switch-signal.js";

const VIEWS_ACTION_NAME = "VIEWS";
const NONE = "none";

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
	async process({ output, message }) {
		const viewId =
			typeof output?.viewId === "string"
				? output.viewId.trim().toLowerCase()
				: "";
		if (!viewId || viewId === NONE) return undefined;
		const messageText =
			typeof message?.content?.text === "string" ? message.content.text : "";
		if (
			viewId === "documents" &&
			isStandaloneNotesSurfaceRequest(messageText)
		) {
			return undefined;
		}

		const client = createViewsClient();
		let views: Awaited<ReturnType<typeof client.listViews>>;
		try {
			views = await client.listViews();
		} catch {
			return undefined; // not a view-capable surface / loopback down
		}
		const target = views.find((view) => view.id === viewId);
		if (!target) return undefined; // model named a view this deployment lacks

		try {
			const current = await client.getCurrentView();
			if (current?.viewId === viewId) return undefined; // already there
		} catch {
			// couldn't read current view — proceed; navigate is idempotent
		}

		const ok = await client.navigate(viewId, {
			path: target.path,
			viewType: target.viewType,
		});
		if (!ok) return undefined;
		// This evaluator runs *after* the reply, so it cannot acknowledge the
		// switch in the just-sent message. Record the switch (and the server
		// stamps it on navigate): the `current_view` provider then acknowledges it
		// on the immediate next turn rather than the user being moved silently.
		markViewSwitch(message?.roomId);
		logger.info(
			`[plugin-app-control] contextual view nav → ${viewId}${output.reason ? ` (${output.reason})` : ""}`,
		);
		return { success: true, values: { contextualView: viewId } };
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
	async shouldRun({ runtime, message, options }) {
		if (options?.didRespond === false) return false;
		// Must be a view-capable app surface (VIEWS registered).
		const hasViews = (runtime.actions ?? []).some(
			(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
		);
		if (!hasViews) return false;
		const text =
			typeof message.content?.text === "string" ? message.content.text : "";
		if (text.trim().length < 8) return false;
		if (isStandaloneNotesSurfaceRequest(text)) return false;
		// Direct nav commands belong to the VIEWS action — only infer contextually
		// when the keyword resolver finds NO direct surface but the turn hints at a
		// mappable activity.
		if (resolveIntentView(text)) return false;
		return ACTIVITY_HINT_RE.test(text);
	},
	prompt({ runtime, message }) {
		const text =
			typeof message.content?.text === "string" ? message.content.text : "";
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
