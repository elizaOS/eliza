/**
 * @module plugin-app-control/actions/homescreen
 *
 * HOMESCREEN action — lets the Eliza agent customize the live homescreen canvas
 * while the user is on it. The user describes a change ("make the background
 * black", "give me a sci-fi Jarvis UI") and the agent rewrites the scene; or
 * issues a history command (undo / redo / reset / duplicate / delete / save).
 *
 * Architecture (rule 4 — actions stay thin): for edit/create this action asks
 * the model for a scene document and forwards it VERBATIM to the client over the
 * view-event channel. It never validates or renders — the client
 * (`packages/ui/src/homescreen/scene-validate`) is the single authority that
 * checks the document and applies it, keeping the prior scene on rejection. The
 * history modes carry no document at all: they emit an opaque op the client
 * applies to its local history stack.
 *
 * View-gating: the planner only surfaces this when the request reads as a
 * homescreen edit. Whether it actually applies is enforced client-side — the
 * client ignores the event unless the homescreen is the active view.
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	type State,
} from "@elizaos/core";
import { normalizeActionOptions, readStringOption } from "../params.js";
import {
	buildHomescreenPrompt,
	extractSceneJson,
	type HomescreenEditMode,
} from "./homescreen-prompt.js";

/** Pure, client-applied history operations (no model call). */
export type HomescreenHistoryOp =
	| "undo"
	| "redo"
	| "reset"
	| "duplicate"
	| "delete"
	| "save";

export type HomescreenMode = HomescreenEditMode | HomescreenHistoryOp;

const HISTORY_OPS: readonly HomescreenHistoryOp[] = [
	"undo",
	"redo",
	"reset",
	"duplicate",
	"delete",
	"save",
] as const;

const ALL_MODES: readonly HomescreenMode[] = [
	"edit",
	"create",
	...HISTORY_OPS,
] as const;

// Intent regexes — order matters: history verbs before the descriptive edit
// fallthrough so "undo that" doesn't get treated as an edit request.
const UNDO_RE = /\b(undo|revert|go back|step back)\b/i;
const REDO_RE = /\b(redo|step forward)\b/i;
const RESET_RE =
	/\b(reset|restore (?:the )?default|factory (?:reset|default)|start over)\b/i;
const DUPLICATE_RE =
	/\b(duplicate|clone|copy)\b.{0,30}\b(homescreen|scene|this)\b/i;
const DELETE_RE =
	/\b(delete|remove|discard)\b.{0,30}\b(homescreen|scene|this)\b/i;
const SAVE_RE = /\b(save|keep)\b.{0,30}\b(homescreen|scene|this|it)\b/i;
// Create = a request for a whole new surface, not a property tweak. "make the
// background black" is an edit, so "make" is intentionally NOT a create verb.
const CREATE_RE =
	/\b(create|build|design|generate)\b.{0,40}\b(home ?screen|wallpaper)\b|\b(new home ?screen|brand[- ]new)\b/i;
// Surfaces the action at all: any reference to the customizable surface or its
// visual properties.
const HOMESCREEN_NOUN_RE =
	/\b(home ?screen|background|wallpaper|backdrop|canvas|scene|crystal ball|orb|theme|accent|interface|\bui\b|look|vibe|style|colou?r|dark mode|light mode)\b/i;

/** A scene fetcher the client side exposes; lets the action read current state. */
export interface HomescreenSceneSource {
	/** Returns the current scene document JSON the client is rendering. */
	getCurrentSceneJson(): Promise<string | null>;
}

/** Pushes a homescreen instruction to the client. */
export type HomescreenEmitter = (
	payload: HomescreenEventPayload,
) => Promise<void>;

export interface HomescreenEventPayload {
	/** Apply a fresh scene document (edit/create), or run a history op. */
	op: HomescreenMode;
	/** Present only for edit/create: the model's raw scene document JSON. */
	sceneJson?: string;
}

export interface HomescreenActionDeps {
	source?: HomescreenSceneSource;
	emit?: HomescreenEmitter;
}

export function inferHomescreenMode(
	text: string,
	options?: Record<string, unknown>,
): HomescreenMode | null {
	const explicit =
		readStringOption(options, "op") ??
		readStringOption(options, "action") ??
		readStringOption(options, "mode");
	if (explicit && (ALL_MODES as readonly string[]).includes(explicit)) {
		return explicit as HomescreenMode;
	}

	const trimmed = text.trim();
	if (!trimmed) return null;

	if (UNDO_RE.test(trimmed)) return "undo";
	if (REDO_RE.test(trimmed)) return "redo";
	if (RESET_RE.test(trimmed)) return "reset";
	if (DUPLICATE_RE.test(trimmed)) return "duplicate";
	if (DELETE_RE.test(trimmed)) return "delete";
	if (SAVE_RE.test(trimmed)) return "save";
	if (CREATE_RE.test(trimmed)) return "create";
	// Anything else that references the surface is an incremental edit.
	if (HOMESCREEN_NOUN_RE.test(trimmed)) return "edit";
	return null;
}

const DEFAULT_SCENE_JSON = JSON.stringify({
	name: "Crystal ball",
	background: { kind: "preset", preset: "fresnel-crystal-ball" },
	theme: { accent: [1, 0.345, 0], background: 0xff5800 },
});

async function defaultEmit(payload: HomescreenEventPayload): Promise<void> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const resp = await fetch(
		`http://127.0.0.1:${port}/api/views/events/broadcast`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "homescreen:apply", payload }),
			signal: AbortSignal.timeout(5_000),
		},
	);
	// A non-2xx means the broadcast did not go out. Throw so the handler reports
	// failure instead of claiming the homescreen changed when it didn't.
	if (!resp.ok) {
		throw new Error(`broadcast returned ${resp.status}`);
	}
}

function isParseableJson(value: string): boolean {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null;
	} catch {
		return false;
	}
}

function historyReply(op: HomescreenHistoryOp): string {
	switch (op) {
		case "undo":
			return "Undid the last homescreen change.";
		case "redo":
			return "Redid the homescreen change.";
		case "reset":
			return "Reset the homescreen to the default crystal ball.";
		case "duplicate":
			return "Duplicated the current homescreen.";
		case "delete":
			return "Removed the current homescreen.";
		case "save":
			return "Saved the homescreen.";
	}
}

export function createHomescreenAction(
	deps: HomescreenActionDeps = {},
): Action {
	const emit = deps.emit ?? defaultEmit;
	const getSceneJson = () =>
		deps.source?.getCurrentSceneJson() ?? Promise.resolve(null);

	return {
		name: "HOMESCREEN",
		contexts: ["general", "settings"],
		contextGate: { anyOf: ["general", "settings"] },
		roleGate: { minRole: "USER" },
		similes: [
			"EDIT_HOMESCREEN",
			"CUSTOMIZE_HOMESCREEN",
			"CHANGE_BACKGROUND",
			"SET_WALLPAPER",
			"EDIT_BACKGROUND",
			"REDESIGN_HOME",
			"UNDO_HOMESCREEN",
			"REDO_HOMESCREEN",
			"RESET_HOMESCREEN",
			"DUPLICATE_HOMESCREEN",
			"SAVE_HOMESCREEN",
		],
		description:
			"Customize the live homescreen canvas while the user is on it. Describe any visual change (background, theme, blocks, a fully custom three.js scene) and the agent rewrites the scene document the client renders. Also runs history commands: undo, redo, reset to default, duplicate, delete, save.",
		descriptionCompressed:
			"homescreen edit|create|undo|redo|reset|duplicate|delete|save; restyle the home canvas background/theme/blocks or author a custom three.js scene from a description",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "op",
				description:
					"Operation: edit | create | undo | redo | reset | duplicate | delete | save.",
				required: false,
				schema: { type: "string", enum: [...ALL_MODES] },
			},
			{
				name: "request",
				description:
					"Natural-language description of the change (edit/create), e.g. 'make the background black' or 'a sci-fi Jarvis UI'.",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			const text = message.content.text ?? "";
			return inferHomescreenMode(text) !== null;
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const actionOptions = normalizeActionOptions(options);
			const text = message.content.text ?? "";
			const mode = inferHomescreenMode(text, actionOptions);

			if (!mode) {
				const reply =
					'Tell me how to change the homescreen — e.g. "make the background black", "give me a sci-fi Jarvis UI", or "undo".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			logger.info(`[plugin-app-control] HOMESCREEN mode=${mode}`);

			// History ops carry no document — just signal the client.
			if ((HISTORY_OPS as readonly string[]).includes(mode)) {
				const op = mode as HomescreenHistoryOp;
				try {
					await emit({ op });
				} catch (err) {
					const reply = `I couldn't apply the homescreen ${op}: ${
						err instanceof Error ? err.message : String(err)
					}.`;
					await callback?.({ text: reply });
					return { success: false, text: reply, error: reply };
				}
				const reply = historyReply(op);
				await callback?.({ text: reply });
				return { success: true, text: reply, values: { mode: op } };
			}

			// edit / create — ask the model for a scene document.
			const request =
				readStringOption(actionOptions, "request") ??
				readStringOption(actionOptions, "intent") ??
				text;
			const currentSceneJson =
				mode === "edit"
					? ((await getSceneJson()) ?? DEFAULT_SCENE_JSON)
					: DEFAULT_SCENE_JSON;

			const prompt = buildHomescreenPrompt({
				mode: mode as HomescreenEditMode,
				request,
				currentSceneJson,
			});

			let raw: string;
			try {
				const runModel = runtime.useModel.bind(runtime);
				raw = await runModel(ModelType.TEXT_LARGE, {
					prompt,
					stopSequences: [],
					// Custom three.js scene scripts are long; a tight budget truncates
					// the document before its closing brace and the client rejects it.
					maxTokens: 8192,
				});
			} catch (err) {
				const reply = `I couldn't reach the model to edit the homescreen: ${
					err instanceof Error ? err.message : String(err)
				}.`;
				await callback?.({ text: reply });
				return { success: false, text: reply, error: reply };
			}

			const sceneJson = extractSceneJson(raw);
			// extractSceneJson only brace-matches — validate it parses as JSON so a
			// truncated/malformed-but-brace-balanced document is rejected here
			// rather than emitted for the client to choke on.
			if (!sceneJson || !isParseableJson(sceneJson)) {
				const reply =
					"The model didn't return a usable scene document, so I kept the current homescreen.";
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			try {
				await emit({ op: mode, sceneJson });
			} catch (err) {
				const reply = `I built the new homescreen but couldn't apply it: ${
					err instanceof Error ? err.message : String(err)
				}.`;
				await callback?.({ text: reply });
				return { success: false, text: reply, error: reply };
			}
			const reply =
				mode === "create"
					? "Created a new homescreen from your description."
					: "Updated the homescreen.";
			await callback?.({ text: reply });
			return {
				success: true,
				text: reply,
				values: { mode },
				data: { sceneJson },
			};
		},

		examples: [
			[
				{ name: "{{user1}}", content: { text: "make the background black" } },
				{
					name: "{{agentName}}",
					content: { text: "Updated the homescreen.", action: "HOMESCREEN" },
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "give me a totally sci-fi looking jarvis UI" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Created a new homescreen from your description.",
						action: "HOMESCREEN",
					},
				},
			],
			[
				{ name: "{{user1}}", content: { text: "undo that" } },
				{
					name: "{{agentName}}",
					content: {
						text: "Undid the last homescreen change.",
						action: "HOMESCREEN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "reset the homescreen to default" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Reset the homescreen to the default crystal ball.",
						action: "HOMESCREEN",
					},
				},
			],
		],
	};
}

export const homescreenAction: Action = createHomescreenAction();
