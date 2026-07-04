/**
 * MODEL_SWITCH action — lets the agent flip its own text inference between
 * on-device (Eliza-1) and Eliza Cloud from chat (#12178 WI-5).
 *
 * The handler POSTs the shared loopback route `POST /api/runtime/model-switch`
 * (packages/agent/src/api/runtime-switch-routes.ts) — the same implementation
 * the deterministic `/model local|cloud` command uses — which applies the
 * switch through the existing local-inference routes and broadcasts
 * `shell:model-switch` to connected shells. Sanctioned models only: local ids
 * come from the curated Eliza-1 catalog (`DEFAULT_ELIGIBLE_MODEL_IDS`), cloud
 * is exactly `DEFAULT_ELIZA_CLOUD_TEXT_MODEL`; both this handler and the route
 * validate against the same shared constants.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger, resolveServerOnlyPort } from "@elizaos/core";
import {
	DEFAULT_ELIGIBLE_MODEL_IDS,
	DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "@elizaos/shared";
import { readStringOption } from "../params.js";

export type ModelSwitchTarget = "local" | "cloud";

/** Parsed wire response of POST /api/runtime/model-switch. */
export interface ModelSwitchOutcome {
	ok: boolean;
	target?: ModelSwitchTarget;
	model?: string;
	displayName?: string;
	status?: "ready" | "loading" | "downloading";
	downloadSizeGb?: number;
	error?: string;
}

export type ModelSwitchFn = (request: {
	target: ModelSwitchTarget;
	model?: string;
}) => Promise<ModelSwitchOutcome>;

export interface ModelSwitchActionDeps {
	switchModel?: ModelSwitchFn;
}

const REQUEST_TIMEOUT_MS = 150_000;

async function defaultSwitchModel(request: {
	target: ModelSwitchTarget;
	model?: string;
}): Promise<ModelSwitchOutcome> {
	const port = resolveServerOnlyPort(process.env);
	const response = await fetch(
		`http://127.0.0.1:${port}/api/runtime/model-switch`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
			// Local activation waits for the model load, which can take a while on
			// first switch — give the route more headroom than a plain API call.
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!response.ok || body?.ok !== true) {
		return {
			ok: false,
			error:
				typeof body?.error === "string"
					? body.error
					: `model switch returned ${response.status}`,
		};
	}
	return {
		ok: true,
		target: body.target === "cloud" ? "cloud" : "local",
		model: typeof body.model === "string" ? body.model : undefined,
		displayName:
			typeof body.displayName === "string" ? body.displayName : undefined,
		status:
			body.status === "ready" ||
			body.status === "loading" ||
			body.status === "downloading"
				? body.status
				: undefined,
		downloadSizeGb:
			typeof body.downloadSizeGb === "number" ? body.downloadSizeGb : undefined,
	};
}

const LOCAL_TARGET_RE = /\b(local(?:ly)?|on[\s-]?device|offline)\b/i;
const CLOUD_TARGET_RE = /\b(cloud|eliza\s?cloud|hosted)\b/i;
const SWITCH_VERB_RE = /\b(switch|use|change|move|go|run|swap)\b/i;
// "eliza cloud" / "on-device" are self-describing inference targets, so they
// satisfy the noun requirement without the word "model".
const MODEL_NOUN_RE =
	/\b(model|inference|llm|eliza[\s-]?1|gemma|eliza\s?cloud|on[\s-]?device)\b/i;
const MODEL_ID_RE = /\beliza-1-[a-z0-9-]+\b/i;

/**
 * Deterministic target/model extraction from an explicit option or the
 * message text. Returns null when the message doesn't name a switch target —
 * MODEL_SWITCH never guesses a direction.
 */
export function inferModelSwitchRequest(
	text: string,
	options?: Record<string, unknown>,
): { target: ModelSwitchTarget; model?: string } | null {
	const explicitTarget = readStringOption(options, "target")?.toLowerCase();
	const explicitModel = readStringOption(options, "model") ?? undefined;
	if (explicitTarget === "local" || explicitTarget === "cloud") {
		return {
			target: explicitTarget,
			...(explicitModel && { model: explicitModel }),
		};
	}

	const trimmed = text.trim();
	if (!trimmed) return null;
	const model = explicitModel ?? MODEL_ID_RE.exec(trimmed)?.[0]?.toLowerCase();

	// A named Eliza-1 tier implies the local target even without the word
	// "local" ("switch to eliza-1-4b").
	const wantsLocal = LOCAL_TARGET_RE.test(trimmed) || Boolean(model);
	const wantsCloud = CLOUD_TARGET_RE.test(trimmed);
	if (wantsLocal === wantsCloud) return null; // ambiguous or absent
	if (!SWITCH_VERB_RE.test(trimmed) || !MODEL_NOUN_RE.test(trimmed))
		return null;

	return {
		target: wantsCloud ? "cloud" : "local",
		...(model ? { model } : {}),
	};
}

/**
 * Pre-flight sanctioned-set check so the agent refuses with a helpful reply
 * instead of a route 400. The route re-validates at the boundary; both read
 * the same shared constants.
 */
export function sanctionedModelError(
	target: ModelSwitchTarget,
	model: string | undefined,
): string | null {
	if (!model) return null;
	if (target === "local" && !DEFAULT_ELIGIBLE_MODEL_IDS.has(model)) {
		return `"${model}" isn't a sanctioned on-device model. I can run: ${[...DEFAULT_ELIGIBLE_MODEL_IDS].join(", ")}.`;
	}
	if (target === "cloud" && model !== DEFAULT_ELIZA_CLOUD_TEXT_MODEL) {
		return `"${model}" isn't a sanctioned cloud model. Eliza Cloud serves ${DEFAULT_ELIZA_CLOUD_TEXT_MODEL}.`;
	}
	return null;
}

function narrate(outcome: ModelSwitchOutcome): string {
	if (outcome.target === "cloud") {
		return `Switched to Eliza Cloud inference (${outcome.model ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL}).`;
	}
	const name = outcome.displayName ?? outcome.model ?? "the local model";
	if (outcome.status === "downloading") {
		const size =
			outcome.downloadSizeGb !== undefined
				? ` (${outcome.downloadSizeGb} GB)`
				: "";
		return `Switching to on-device ${name} — downloading${size}… I'll answer with it as soon as it's ready.`;
	}
	if (outcome.status === "loading") {
		return `Switching to on-device ${name} — loading the model now.`;
	}
	return `Switched to on-device ${name}.`;
}

export function createModelSwitchAction(
	deps: ModelSwitchActionDeps = {},
): Action {
	const switchModel = deps.switchModel ?? defaultSwitchModel;

	return {
		name: "MODEL_SWITCH",
		contexts: ["general", "settings"],
		contextGate: { anyOf: ["general", "settings"] },
		roleGate: { minRole: "USER" },
		similes: [
			"SWITCH_MODEL",
			"USE_LOCAL_MODEL",
			"USE_CLOUD_MODEL",
			"SWITCH_TO_LOCAL",
			"SWITCH_TO_CLOUD",
			"SWITCH_TO_ELIZA_CLOUD",
			"USE_ON_DEVICE_MODEL",
			"CHANGE_MODEL",
			"SELECT_MODEL",
		],
		description:
			"Switch the agent's text inference between the on-device Eliza-1 model (local) and Eliza Cloud (cloud). Optionally name a specific sanctioned Eliza-1 tier (e.g. eliza-1-2b, eliza-1-4b) for the local target. Applies immediately — assigns the model, flips inference routing, and starts a download when the local model isn't installed yet.",
		descriptionCompressed:
			"model switch local|cloud [eliza-1 tier] — flip text inference between on-device Eliza-1 and Eliza Cloud; downloads the local model when missing",
		routingHint:
			"Requests to change WHERE inference runs -> MODEL_SWITCH: 'switch to the local model', 'use cloud inference', 'run on-device', 'switch to eliza cloud', 'use eliza-1-4b'. This changes the live model routing; it is NOT settings navigation (opening the model settings page is VIEWS) and NOT a per-conversation preference.",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "target",
				description:
					"Where text inference should run: local (on-device Eliza-1) or cloud (Eliza Cloud).",
				required: true,
				schema: { type: "string", enum: ["local", "cloud"] },
			},
			{
				name: "model",
				description:
					"Optional sanctioned model id. Local: a curated Eliza-1 tier (eliza-1-2b, eliza-1-4b, …). Cloud: the managed default only.",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			return (
				inferModelSwitchRequest(message.content.text ?? "", undefined) !== null
			);
		},

		handler: async (
			_runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const request = inferModelSwitchRequest(
				message.content.text ?? "",
				options,
			);
			if (!request) {
				const reply =
					'Tell me where to run inference — "switch to the local model" or "use Eliza Cloud". You can also name a tier, e.g. "use eliza-1-4b".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			const refusal = sanctionedModelError(request.target, request.model);
			if (refusal) {
				await callback?.({ text: refusal });
				return {
					success: false,
					text: refusal,
					values: { target: request.target, model: request.model },
				};
			}

			logger.info(
				`[plugin-app-control] MODEL_SWITCH target=${request.target}${request.model ? ` model=${request.model}` : ""}`,
			);

			try {
				const outcome = await switchModel(request);
				if (!outcome.ok) {
					const reply = `I couldn't switch the model: ${outcome.error ?? "unknown error"}.`;
					await callback?.({ text: reply });
					return {
						success: false,
						text: reply,
						values: { target: request.target, model: request.model },
					};
				}
				const reply = narrate(outcome);
				await callback?.({ text: reply });
				return {
					success: true,
					text: reply,
					values: {
						target: outcome.target ?? request.target,
						model: outcome.model,
						status: outcome.status,
					},
					data: {
						target: outcome.target ?? request.target,
						model: outcome.model,
						displayName: outcome.displayName,
						status: outcome.status,
						...(outcome.downloadSizeGb !== undefined
							? { downloadSizeGb: outcome.downloadSizeGb }
							: {}),
					},
				};
			} catch (err) {
				const messageText = err instanceof Error ? err.message : String(err);
				logger.error(
					`[plugin-app-control] MODEL_SWITCH failed: ${messageText}`,
				);
				const reply = `I couldn't switch the model: ${messageText}.`;
				await callback?.({ text: reply });
				return {
					success: false,
					text: reply,
					values: { target: request.target, model: request.model },
				};
			}
		},
	};
}

export const modelSwitchAction: Action = createModelSwitchAction();
