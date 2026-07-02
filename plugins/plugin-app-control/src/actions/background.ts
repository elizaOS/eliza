/**
 * @module plugin-app-control/actions/background
 *
 * BACKGROUND action — lets the Eliza agent change the unified app background
 * from chat: pick a color, set an uploaded image, generate one from a prompt,
 * undo the last change, redo it, or reset to default.
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
export type BackgroundApplyOp = "set" | "undo" | "redo" | "reset";

/** Tunable GLSL uniform patch the agent can drive (#10694). The GLSL source
 * itself lives in `@elizaos/ui` — the action only names a preset id + uniforms;
 * the renderer resolves id → source and validates it. */
export interface ShaderUniformPatch {
	u_speed?: number;
	u_scale?: number;
	u_intensity?: number;
	u_seed?: number;
}

/**
 * Payload broadcast to the renderer. Mirrors the contract consumed by
 * `useBackgroundApplyChannel` in `@elizaos/ui` — keep the two in sync.
 */
export interface BackgroundApplyPayload {
	op: BackgroundApplyOp;
	/** "shader" (color field), "image" (cover image), or "glsl" (programmable
	 * shader). Omitted for undo/redo/reset. */
	mode?: "shader" | "image" | "glsl";
	/** 6-digit hex for shader/glsl mode. */
	color?: string;
	/** Same-origin image URL (`/api/media/…`) for image mode. */
	imageUrl?: string;
	/** Named GLSL preset id (renderer resolves → source) for glsl mode. */
	presetId?: string;
	/** Uniform patch for glsl mode (named preset set or a live-shader tweak). */
	uniforms?: ShaderUniformPatch;
}

/** The resolved plan for one BACKGROUND invocation. */
type BackgroundPlan =
	| { op: "undo" }
	| { op: "redo" }
	| { op: "reset" }
	| { op: "set"; mode: "shader"; color: string; colorLabel: string }
	| { op: "set"; mode: "image"; imageUrl: string }
	| { op: "set"; mode: "glsl"; presetId: string; presetLabel: string }
	| {
			op: "set";
			mode: "glsl-tweak";
			uniforms: ShaderUniformPatch;
			tweakLabel: string;
	  }
	| { op: "set"; generatePrompt: string };

// Any reference to the background surface — gates the action so unrelated chat
// never triggers it. Deliberately excludes "homescreen"/"scene": the dead
// three.js scene path was removed; "background"/"wallpaper" now mean THIS layer.
const BACKGROUND_NOUN_RE = /\b(background|wallpaper|backdrop)\b/i;
// History verbs (checked before set, so "go back" isn't read as an edit).
// "put/switch … back" covers the surface-named forms live models produce
// ("put the background back", "switch the wallpaper back") — #11360.
const UNDO_RE =
	/\b(undo|revert|go back|switch back|change it back|put (?:it|that|the (?:background|wallpaper|backdrop)) back|previous)\b/i;
// Forward history verbs — mirror of UNDO_RE for the redo direction (#10694).
// Matched before color resolution so "redo" can never false-match "red".
const REDO_RE = /\b(redo|re-?do|go forward|step forward|re-?apply)\b/i;
// Reset also accepts "restore/back to the original" (#11360). Ops are checked
// undo → redo → reset, and the undo/redo branches yield when RESET_RE matches,
// so "go back to the default look" resolves to reset, not undo.
const RESET_RE =
	/\b(reset|restore (?:the )?(?:default|original)|back to (?:the )?(?:default|original)|default|factory)\b/i;
// "set/make/change … background …" — a request to apply something.
const SET_RE = /\b(set|make|change|use|turn|switch|give me|apply|put)\b/i;
// Explicit ask for a generated image rather than a flat color.
const GENERATE_RE = /\b(generate|create|paint|draw|design|render|imagine)\b/i;
// References to an attachment-like object. If these are present with unusable
// attachment records, do not reinterpret the request as an image-generation
// prompt like "from this attachment".
const ATTACHMENT_REFERENCE_RE =
	/\b(this|that|these|those|attached|attachment|upload(?:ed)?|file)\b/i;

// ── Programmable GLSL shader (#10694) ───────────────────────────────────────
// The action names a preset id; the GLSL source lives in @elizaos/ui, where the
// renderer resolves id → source. Keep these ids in sync with SHADER_PRESETS.
const SHADER_PRESET_TRIGGERS: ReadonlyArray<readonly [RegExp, string, string]> =
	[
		[/\b(aurora|northern lights|ribbons?)\b/i, "aurora", "aurora"],
		[/\b(lava|molten|magma|volcano|fire|fiery|ember)\b/i, "lava", "lava"],
		[/\b(plasma|psychedelic|trippy|kaleidoscop)\b/i, "plasma", "plasma"],
		[/\b(waves?|ocean|water|sea|ripples?|tide)\b/i, "waves", "waves"],
		[
			/\b(nebula|space|cosmic|galaxy|stars?|clouds?|smoke)\b/i,
			"nebula",
			"nebula",
		],
	];
// Any explicit ask for the programmable/animated shader mode.
const SHADER_NOUN_RE = /\b(shaders?|animated|programmable|glsl|generative)\b/i;
const DEFAULT_SHADER_PRESET = "aurora";
// Relative tweak verbs → absolute uniform targets. Applied by the renderer only
// when a GLSL shader is already live (a no-op otherwise).
const SHADER_TWEAK_TRIGGERS: ReadonlyArray<
	readonly [RegExp, ShaderUniformPatch, string]
> = [
	[
		/\b(slower|slow down|calmer|gentler|relax(?:ed)?)\b/i,
		{ u_speed: 0.4 },
		"slower",
	],
	[
		/\b(faster|speed up|quicker|energetic|livel(?:y|ier))\b/i,
		{ u_speed: 2.2 },
		"faster",
	],
	[
		/\b(brighter|more intense|intenser|vivid|vibrant|bolder)\b/i,
		{ u_intensity: 1.7 },
		"brighter",
	],
	[
		/\b(dimmer|darker|subtler|softer|muted|fade[rd]?)\b/i,
		{ u_intensity: 0.5 },
		"dimmer",
	],
	[
		/\b(bigger|larger|zoom in|zoomed in|coarser)\b/i,
		{ u_scale: 0.5 },
		"bigger",
	],
	[
		/\b(smaller|finer|more detail(?:ed)?|zoom out|zoomed out|busier)\b/i,
		{ u_scale: 2.8 },
		"more detailed",
	],
];

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
		const named = NAMED_COLORS.find(
			([name]) => name === explicit.toLowerCase(),
		);
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
		const url = typeof att.url === "string" ? att.url : "";
		const looksImage =
			att.contentType === "image" ||
			/\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(url) ||
			url.startsWith("data:image/");
		if (looksImage && url) return att;
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
	const explicitPreset = readStringOption(options, "preset");
	const trimmed = text.trim();
	const mentionsBackground =
		BACKGROUND_NOUN_RE.test(trimmed) ||
		// "make the shader slower" is a background request even without the word
		// "background" (but NOT bare "animated"/"generative" — too ambiguous).
		/\b(shaders?|glsl)\b/i.test(trimmed) ||
		Boolean(
			explicitOp ||
				explicitColor ||
				explicitImage ||
				explicitPrompt ||
				explicitPreset,
		);

	if (!mentionsBackground) return null;

	if (
		explicitOp === "undo" ||
		(UNDO_RE.test(trimmed) && !RESET_RE.test(trimmed))
	)
		return { op: "undo" };
	if (
		explicitOp === "redo" ||
		(REDO_RE.test(trimmed) && !RESET_RE.test(trimmed))
	)
		return { op: "redo" };
	if (explicitOp === "reset" || RESET_RE.test(trimmed)) return { op: "reset" };

	// Explicit options win over text parsing.
	if (explicitImage)
		return { op: "set", mode: "image", imageUrl: explicitImage };
	if (explicitPreset) {
		// An explicit preset only outranks a resolvable color when the text
		// itself asks for a shader (shader noun / preset vocabulary). Observed
		// live in the #10694 trajectories: the planner stuffed `preset:"aurora"`
		// alongside `color:"teal"` on "change the app background to teal",
		// turning a plain color request into the aurora shader.
		const textAsksForShader =
			SHADER_NOUN_RE.test(trimmed) ||
			SHADER_PRESET_TRIGGERS.some(([re]) => re.test(trimmed));
		const presetColor = textAsksForShader
			? null
			: resolveColor(trimmed, explicitColor);
		if (presetColor)
			return {
				op: "set",
				mode: "shader",
				color: presetColor.color,
				colorLabel: presetColor.label,
			};
		return {
			op: "set",
			mode: "glsl",
			presetId: explicitPreset,
			presetLabel: explicitPreset,
		};
	}

	// A named GLSL preset ("give me a lava background") is shader-specific
	// vocabulary, so it resolves BEFORE a bare color — "molten" beats no color.
	const presetMatch = SHADER_PRESET_TRIGGERS.find(([re]) => re.test(trimmed));
	if (presetMatch)
		return {
			op: "set",
			mode: "glsl",
			presetId: presetMatch[1],
			presetLabel: presetMatch[2],
		};

	// A concrete color wins over the generic "animated shader" / tweak words
	// below (so "make it red brighter" lands on red, not a uniform tweak).
	const color = resolveColor(trimmed, explicitColor);
	if (color)
		return {
			op: "set",
			mode: "shader",
			color: color.color,
			colorLabel: color.label,
		};

	// A relative tweak ("slower", "brighter") — checked BEFORE the generic
	// shader fallback so "make the shader slower" is a uniform tweak, not a
	// fresh default preset. The renderer applies it to the live shader's
	// uniforms (a no-op if the current background isn't a shader).
	const tweak = SHADER_TWEAK_TRIGGERS.find(([re]) => re.test(trimmed));
	if (tweak)
		return {
			op: "set",
			mode: "glsl-tweak",
			uniforms: tweak[1],
			tweakLabel: tweak[2],
		};

	// A generic ask for the programmable shader with no preset/tweak → default.
	if (SHADER_NOUN_RE.test(trimmed))
		return {
			op: "set",
			mode: "glsl",
			presetId: DEFAULT_SHADER_PRESET,
			presetLabel: DEFAULT_SHADER_PRESET,
		};

	if (explicitPrompt) return { op: "set", generatePrompt: explicitPrompt };

	// An attached image the user wants to use.
	const image = firstImageAttachment(attachments);
	if (image && (SET_RE.test(trimmed) || GENERATE_RE.test(trimmed))) {
		return { op: "set", mode: "image", imageUrl: image.url };
	}
	if (
		attachments?.length &&
		ATTACHMENT_REFERENCE_RE.test(trimmed) &&
		SET_RE.test(trimmed)
	) {
		return null;
	}

	// A described background to generate.
	if (GENERATE_RE.test(trimmed) || SET_RE.test(trimmed)) {
		const prompt = extractGeneratePrompt(trimmed);
		if (prompt.length >= 3) return { op: "set", generatePrompt: prompt };
	}

	return null;
}

/** Pushes a `background:apply` event to all connected frontends. */
export type BackgroundEmitter = (
	payload: BackgroundApplyPayload,
) => Promise<void>;
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

export function createBackgroundAction(
	deps: BackgroundActionDeps = {},
): Action {
	const emit = deps.emit ?? defaultEmit;
	const generateImage = deps.generateImage ?? defaultGenerateImage;

	return {
		name: "BACKGROUND",
		// "media": the generate-a-wallpaper path IS image generation, and live
		// models route "generate a misty forest background" there. "code": live
		// models classify "give me a … animated background" as a build request
		// (observed on gemma-4-31b: contexts=["code"], candidates
		// GENERATE_CODE/CREATE_FILE), and a context-gated BACKGROUND then never
		// reaches the planner surface at all — the programmable-shader ask
		// belongs to this action, so it must survive that classification (#11360).
		contexts: ["general", "settings", "media", "code"],
		contextGate: { anyOf: ["general", "settings", "media", "code"] },
		roleGate: { minRole: "USER" },
		similes: [
			"SET_BACKGROUND",
			"CHANGE_BACKGROUND",
			"SET_BACKGROUND_COLOR",
			"CHANGE_BACKGROUND_COLOR",
			"SET_WALLPAPER",
			"CHANGE_WALLPAPER",
			"EDIT_BACKGROUND",
			"UNDO_BACKGROUND",
			"UNDO_BACKGROUND_CHANGE",
			"UNDO_WALLPAPER",
			"REVERT_BACKGROUND",
			"REDO_BACKGROUND",
			"REDO_BACKGROUND_CHANGE",
			"REDO_WALLPAPER",
			"RESTORE_BACKGROUND",
			"RESET_BACKGROUND",
			"RESET_WALLPAPER",
		],
		description:
			"Change the app background (wallpaper/backdrop) from chat: set a color, run an animated programmable shader (aurora/lava/plasma/waves/nebula) and tweak it (slower/brighter/bigger), use an uploaded image, generate one from a description, undo/revert the last background change, redo the background change you undid, or reset/restore the default background. Drives the unified background shared by the home and every view. Undo, redo, and reset of a background or wallpaper change belong to this action, not to settings.",
		descriptionCompressed:
			"background set color|shader|image|generate|undo|redo|reset — recolor the app background/wallpaper, run an animated shader preset (aurora/lava/plasma/waves/nebula) + tweak (slower/brighter/bigger), set an uploaded/generated wallpaper, undo/revert the background change, redo it, or reset/restore the default background",
		routingHint:
			"Any request about the app background, wallpaper, or backdrop -> BACKGROUND: setting a color/image/animated shader AND the follow-ups 'undo that background change', 'revert the wallpaper', 'redo the background change', 'put the background back', 'reset the background to the default'. Background undo/redo/reset sounds like a settings tweak but is NOT settings/views navigation — do not route it to VIEWS or a settings page; BACKGROUND applies the change directly. Only opening a settings/background page to look at it is VIEWS.",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "op",
				description: "Operation: set | undo | redo | reset.",
				required: false,
				schema: { type: "string", enum: ["set", "undo", "redo", "reset"] },
			},
			{
				name: "color",
				description: "A color name or hex (e.g. 'teal' or '#0891b2') for set.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "preset",
				description:
					"Animated shader preset for set: aurora | lava | plasma | waves | nebula.",
				required: false,
				schema: {
					type: "string",
					enum: ["aurora", "lava", "plasma", "waves", "nebula"],
				},
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
				if (plan.op === "redo") {
					await emit({ op: "redo" });
					const reply = "Re-applied the background you undid.";
					await callback?.({ text: reply });
					return { success: true, text: reply, values: { op: "redo" } };
				}
				if (plan.op === "reset") {
					await emit({ op: "reset" });
					const reply = "Reset the background to the default.";
					await callback?.({ text: reply });
					return { success: true, text: reply, values: { op: "reset" } };
				}
				if ("mode" in plan && plan.mode === "glsl") {
					// Named programmable-shader preset. The renderer resolves the
					// preset id → GLSL source + its default uniforms.
					await emit({ op: "set", mode: "glsl", presetId: plan.presetId });
					const reply = `Set the background to the ${plan.presetLabel} shader.`;
					await callback?.({ text: reply });
					return {
						success: true,
						text: reply,
						values: { op: "set", mode: "glsl", presetId: plan.presetId },
					};
				}
				if ("mode" in plan && plan.mode === "glsl-tweak") {
					// A relative tweak to the live shader's uniforms.
					await emit({ op: "set", mode: "glsl", uniforms: plan.uniforms });
					const reply = `Made the shader background ${plan.tweakLabel}.`;
					await callback?.({ text: reply });
					return {
						success: true,
						text: reply,
						values: { op: "set", mode: "glsl", tweak: plan.tweakLabel },
					};
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
					content: {
						text: "Set the background to teal.",
						action: "BACKGROUND",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "give me a cool animated lava background" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Set the background to the lava shader.",
						action: "BACKGROUND",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "make the shader slower" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Made the shader background slower.",
						action: "BACKGROUND",
					},
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
				{
					name: "{{user1}}",
					content: { text: "undo that background change" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Reverted the background to the previous one.",
						action: "BACKGROUND",
					},
				},
			],
			[
				{ name: "{{user1}}", content: { text: "revert the wallpaper" } },
				{
					name: "{{agentName}}",
					content: {
						text: "Reverted the background to the previous one.",
						action: "BACKGROUND",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "redo the background change" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Re-applied the background you undid.",
						action: "BACKGROUND",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "reset the background to the default look" },
				},
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
