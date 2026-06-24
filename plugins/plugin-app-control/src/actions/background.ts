/**
 * @module plugin-app-control/actions/background
 *
 * BACKGROUND action — lets the Eliza agent change the unified app background
 * from chat: pick a color, set an uploaded image, generate one from a prompt,
 * undo the last change, or reset to default.
 *
 * This is the single agent-side control path for the background. It drives the
 * SAME `BackgroundConfig` the Background view and the always-mounted
 * `AppBackground` layer share — there is no second "homescreen scene" surface.
 * The action stays thin (rule 4): it resolves the intent, optionally generates
 * an image via the existing media route, and broadcasts ONE `background:apply`
 * view event. The renderer's single subscriber (`useBackgroundApplyChannel` in
 * `@elizaos/ui`) applies it to the persisted store and maintains undo history.
 *
 * Delivery: `POST /api/views/events/broadcast { type: "background:apply" }` →
 * WS `view:event` → `emitViewEvent` → `useViewEvent("background:apply")`. Unlike
 * a per-view edit, the background applies globally, so this works from any view.
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Media,
	type Memory,
	type State,
} from "@elizaos/core";
import { normalizeActionOptions, readStringOption } from "../params.js";

/** Operation carried by the `background:apply` event. */
export type BackgroundApplyOp = "set" | "undo" | "reset";

/**
 * Payload broadcast to the renderer. Mirrors the contract consumed by
 * `useBackgroundApplyChannel` in `@elizaos/ui` — keep the two in sync.
 */
export interface BackgroundApplyPayload {
	op: BackgroundApplyOp;
	/** "shader" (color field) or "image" (cover image). Omitted for undo/reset. */
	mode?: "shader" | "image";
	/** 6-digit hex for shader mode. */
	color?: string;
	/** Same-origin image URL (`/api/media/…`) for image mode. */
	imageUrl?: string;
}

/** The resolved plan for one BACKGROUND invocation. */
type BackgroundPlan =
	| { op: "undo" }
	| { op: "reset" }
	| { op: "set"; mode: "shader"; color: string; colorLabel: string }
	| { op: "set"; mode: "image"; imageUrl: string }
	| { op: "set"; generatePrompt: string };

// Any reference to the background surface — gates the action so unrelated chat
// never triggers it. Deliberately excludes "homescreen"/"scene": the dead
// three.js scene path was removed; "background"/"wallpaper" now mean THIS layer.
const BACKGROUND_NOUN_RE = /\b(background|wallpaper|backdrop)\b/i;
// History verbs (checked before set, so "go back" isn't read as an edit).
const UNDO_RE = /\b(undo|revert|go back|change it back|put it back|previous)\b/i;
const RESET_RE = /\b(reset|restore (?:the )?default|default|factory)\b/i;
// "set/make/change … background …" — a request to apply something.
const SET_RE =
	/\b(set|make|change|use|turn|switch|give me|apply|put)\b/i;
// Explicit ask for a generated image rather than a flat color.
const GENERATE_RE =
	/\b(generate|create|paint|draw|design|render|imagine)\b/i;

/**
 * Curated color-name → hex map. Multi-word keys are listed first so "light
 * blue" wins over "blue". "orange" maps to the brand default (#ef5a1f), not CSS
 * orange, so "make it orange" lands on the same warm field as the default.
 */
const NAMED_COLORS: ReadonlyArray<readonly [string, string]> = [
	["light blue", "#60a5fa"],
	["dark blue", "#1e3a8a"],
	["navy", "#1e3a8a"],
	["sky blue", "#38bdf8"],
	["light green", "#4ade80"],
	["dark green", "#166534"],
	["forest green", "#166534"],
	["hot pink", "#ec4899"],
	["light gray", "#d4d4d8"],
	["light grey", "#d4d4d8"],
	["dark gray", "#3f3f46"],
	["dark grey", "#3f3f46"],
	["orange", "#ef5a1f"],
	["amber", "#f59e0b"],
	["gold", "#f59e0b"],
	["yellow", "#eab308"],
	["red", "#dc2626"],
	["crimson", "#e11d48"],
	["rose", "#e11d48"],
	["pink", "#ec4899"],
	["magenta", "#d946ef"],
	["purple", "#7c3aed"],
	["violet", "#7c3aed"],
	["indigo", "#4f46e5"],
	["blue", "#2563eb"],
	["cyan", "#06b6d4"],
	["teal", "#0891b2"],
	["turquoise", "#06b6d4"],
	["green", "#059669"],
	["lime", "#65a30d"],
	["emerald", "#059669"],
	["slate", "#334155"],
	["gray", "#64748b"],
	["grey", "#64748b"],
	["brown", "#92400e"],
	["black", "#0a0a0a"],
	["white", "#f4f4f5"],
	["light", "#f4f4f5"],
];

/** Normalize a 3- or 6-digit hex (with/without `#`) to lowercase `#rrggbb`. */
function normalizeHex(value: string): string | null {
	const m = value.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
	if (!m) return null;
	let hex = m[1].toLowerCase();
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((c) => c + c)
			.join("");
	}
	return `#${hex}`;
}

/**
 * Resolve a color from free text or an explicit option: a hex literal, then a
 * named color. Returns the hex plus a human label for the reply, or null.
 */
function resolveColor(
	text: string,
	explicit: string | null,
): { color: string; label: string } | null {
	if (explicit) {
		const hex = normalizeHex(explicit);
		if (hex) return { color: hex, label: hex };
		const named = NAMED_COLORS.find(([name]) => name === explicit.toLowerCase());
		if (named) return { color: named[1], label: explicit.toLowerCase() };
	}
	const hexMatch = text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/);
	if (hexMatch) {
		const hex = normalizeHex(hexMatch[0]);
		if (hex) return { color: hex, label: hex };
	}
	const lower = text.toLowerCase();
	for (const [name, hex] of NAMED_COLORS) {
		if (new RegExp(`\\b${name}\\b`).test(lower)) {
			return { color: hex, label: name };
		}
	}
	return null;
}

/** First image attachment on the triggering message, if any. */
function firstImageAttachment(attachments?: Media[]): Media | null {
	if (!attachments?.length) return null;
	for (const att of attachments) {
		const looksImage =
			att.contentType === "image" ||
			/\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(att.url) ||
			att.url.startsWith("data:image/");
		if (looksImage && att.url) return att;
	}
	return null;
}

/** Strip the command framing so the rest reads as an image prompt. */
function extractGeneratePrompt(text: string): string {
	return text
		.replace(BACKGROUND_NOUN_RE, " ")
		.replace(
			/\b(set|make|change|use|turn|switch|give me|apply|put|generate|create|paint|draw|design|render|imagine|to|a|an|the|my|of|with|please|that looks like|looks like|like)\b/gi,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve the user's request into a single plan. Returns null when the message
 * isn't an actionable background request (so the action stays un-triggered).
 */
export function inferBackgroundPlan(
	text: string,
	attachments: Media[] | undefined,
	options?: Record<string, unknown>,
): BackgroundPlan | null {
	const explicitOp = readStringOption(options, "op");
	const explicitColor = readStringOption(options, "color");
	const explicitImage = readStringOption(options, "imageUrl");
	const explicitPrompt = readStringOption(options, "prompt");
	const trimmed = text.trim();
	const mentionsBackground =
		BACKGROUND_NOUN_RE.test(trimmed) ||
		Boolean(explicitOp || explicitColor || explicitImage || explicitPrompt);

	if (!mentionsBackground) return null;

	if (explicitOp === "undo" || (UNDO_RE.test(trimmed) && !RESET_RE.test(trimmed)))
		return { op: "undo" };
	if (explicitOp === "reset" || RESET_RE.test(trimmed)) return { op: "reset" };

	// Explicit options win over text parsing.
	if (explicitImage) return { op: "set", mode: "image", imageUrl: explicitImage };
	const color = resolveColor(trimmed, explicitColor);
	if (color)
		return { op: "set", mode: "shader", color: color.color, colorLabel: color.label };
	if (explicitPrompt) return { op: "set", generatePrompt: explicitPrompt };

	// An attached image the user wants to use.
	const image = firstImageAttachment(attachments);
	if (image && (SET_RE.test(trimmed) || GENERATE_RE.test(trimmed))) {
		return { op: "set", mode: "image", imageUrl: image.url };
	}

	// A described background to generate.
	if (GENERATE_RE.test(trimmed) || SET_RE.test(trimmed)) {
		const prompt = extractGeneratePrompt(trimmed);
		if (prompt.length >= 3) return { op: "set", generatePrompt: prompt };
	}

	return null;
}

/** Pushes a `background:apply` event to all connected frontends. */
export type BackgroundEmitter = (payload: BackgroundApplyPayload) => Promise<void>;
/** Generates a background image from a prompt; returns a served URL. */
export type BackgroundImageGenerator = (prompt: string) => Promise<string>;

export interface BackgroundActionDeps {
	emit?: BackgroundEmitter;
	generateImage?: BackgroundImageGenerator;
}

async function loopbackPort(): Promise<number> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	return resolveServerOnlyPort(process.env);
}

async function defaultEmit(payload: BackgroundApplyPayload): Promise<void> {
	const port = await loopbackPort();
	const resp = await fetch(
		`http://127.0.0.1:${port}/api/views/events/broadcast`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "background:apply", payload }),
			signal: AbortSignal.timeout(5_000),
		},
	);
	// A non-2xx means the event did not go out — surface failure rather than
	// claiming the background changed when it didn't.
	if (!resp.ok) throw new Error(`broadcast returned ${resp.status}`);
}

async function defaultGenerateImage(prompt: string): Promise<string> {
	const port = await loopbackPort();
	const resp = await fetch(
		`http://127.0.0.1:${port}/api/background/generate-image`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt }),
			signal: AbortSignal.timeout(120_000),
		},
	);
	const data = (await resp.json().catch(() => null)) as {
		url?: string;
		error?: string;
	} | null;
	if (!resp.ok || !data?.url) {
		throw new Error(data?.error ?? `image generation returned ${resp.status}`);
	}
	return data.url;
}

export function createBackgroundAction(deps: BackgroundActionDeps = {}): Action {
	const emit = deps.emit ?? defaultEmit;
	const generateImage = deps.generateImage ?? defaultGenerateImage;

	return {
		name: "BACKGROUND",
		contexts: ["general", "settings"],
		contextGate: { anyOf: ["general", "settings"] },
		roleGate: { minRole: "USER" },
		similes: [
			"SET_BACKGROUND",
			"CHANGE_BACKGROUND",
			"SET_WALLPAPER",
			"CHANGE_WALLPAPER",
			"EDIT_BACKGROUND",
			"UNDO_BACKGROUND",
			"RESET_BACKGROUND",
		],
		description:
			"Change the app background from chat: set a color, use an uploaded image, generate one from a description, undo the last change, or reset to default. Drives the unified background shared by the home and every view.",
		descriptionCompressed:
			"background set color|image|generate|undo|reset — recolor the app background, set an uploaded/generated wallpaper, undo, or reset to default",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "op",
				description: "Operation: set | undo | reset.",
				required: false,
				schema: { type: "string", enum: ["set", "undo", "reset"] },
			},
			{
				name: "color",
				description: "A color name or hex (e.g. 'teal' or '#0891b2') for set.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "prompt",
				description: "Describe a background to generate (e.g. 'a calm beach').",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			return (
				inferBackgroundPlan(
					message.content.text ?? "",
					message.content.attachments,
				) !== null
			);
		},

		handler: async (
			_runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const actionOptions = normalizeActionOptions(options);
			const plan = inferBackgroundPlan(
				message.content.text ?? "",
				message.content.attachments,
				actionOptions,
			);

			if (!plan) {
				const reply =
					'Tell me how to change the background — e.g. "make the background teal", "use this photo", "generate a misty forest", or "undo".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			logger.info(
				`[plugin-app-control] BACKGROUND op=${plan.op}${
					"mode" in plan ? ` mode=${plan.mode}` : ""
				}`,
			);

			try {
				if (plan.op === "undo") {
					await emit({ op: "undo" });
					const reply = "Reverted the background to the previous one.";
					await callback?.({ text: reply });
					return { success: true, text: reply, values: { op: "undo" } };
				}
				if (plan.op === "reset") {
					await emit({ op: "reset" });
					const reply = "Reset the background to the default.";
					await callback?.({ text: reply });
					return { success: true, text: reply, values: { op: "reset" } };
				}
				if ("mode" in plan && plan.mode === "shader") {
					await emit({ op: "set", mode: "shader", color: plan.color });
					const reply = `Set the background to ${plan.colorLabel}.`;
					await callback?.({ text: reply });
					return {
						success: true,
						text: reply,
						values: { op: "set", mode: "shader", color: plan.color },
					};
				}
				if ("mode" in plan && plan.mode === "image") {
					await emit({ op: "set", mode: "image", imageUrl: plan.imageUrl });
					const reply = "Set your image as the background.";
					await callback?.({ text: reply });
					return {
						success: true,
						text: reply,
						values: { op: "set", mode: "image" },
						data: { imageUrl: plan.imageUrl },
					};
				}
				// generate
				const url = await generateImage(plan.generatePrompt);
				await emit({ op: "set", mode: "image", imageUrl: url });
				const reply = `Generated a new background from "${plan.generatePrompt}".`;
				await callback?.({ text: reply });
				return {
					success: true,
					text: reply,
					values: { op: "set", mode: "image" },
					data: { imageUrl: url, prompt: plan.generatePrompt },
				};
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				const reply = `I couldn't change the background: ${detail}.`;
				await callback?.({ text: reply });
				return { success: false, text: reply, error: reply };
			}
		},

		examples: [
			[
				{ name: "{{user1}}", content: { text: "make the background teal" } },
				{
					name: "{{agentName}}",
					content: { text: "Set the background to teal.", action: "BACKGROUND" },
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "generate a misty forest background" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Generated a new background from "misty forest".',
						action: "BACKGROUND",
					},
				},
			],
			[
				{ name: "{{user1}}", content: { text: "undo the background" } },
				{
					name: "{{agentName}}",
					content: {
						text: "Reverted the background to the previous one.",
						action: "BACKGROUND",
					},
				},
			],
			[
				{ name: "{{user1}}", content: { text: "reset the background" } },
				{
					name: "{{agentName}}",
					content: {
						text: "Reset the background to the default.",
						action: "BACKGROUND",
					},
				},
			],
		],
	};
}

export const backgroundAction: Action = createBackgroundAction();
