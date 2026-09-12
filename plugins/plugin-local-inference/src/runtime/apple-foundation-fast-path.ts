/**
 * Apple Foundation Models fast path for the local text handler on iOS 26+.
 *
 * The adapter in `../backends/apple-foundation` is an opportunistic route,
 * never the owned backend: it is registered at iOS boot only when the
 * Capacitor `ComputerUse` bridge probe reports `foundationModel: true`, and
 * the local text handler consults it only for plain short-prompt calls
 * (`TEXT_SMALL` / `TEXT_COMPLETION`). Planner and response-handler model types
 * share the TEXT_SMALL slot but depend on llama.cpp's structured decoding
 * (grammar, skeletons, span samplers, streaming), which the out-of-process OS
 * model cannot honour, so they never take this path. `ELIZA_APPLE_FOUNDATION_FAST_PATH=0`
 * disables it without touching the registration.
 */
import { type GenerateTextParams, logger, ModelType } from "@elizaos/core";
import type { IosComputerUseBridge } from "@elizaos/plugin-computeruse/mobile/ios-bridge";

import {
	type AppleFoundationAdapter,
	createAppleFoundationAdapter,
	getAppleFoundationAdapter,
	registerAppleFoundationAdapter,
} from "../backends/apple-foundation";
import { mergeElizaTurnStopSequences } from "../services/eliza-turn-stops";

type IosBridge = IosComputerUseBridge;

/** Capacitor plugin jsName; kept in sync with `IOS_BRIDGE_JS_NAME` in plugin-computeruse. */
const IOS_COMPUTER_USE_PLUGIN = "ComputerUse";

/**
 * The live `Capacitor.Plugins.ComputerUse` handle, or `null` off the
 * Capacitor iOS shell. Mirrors plugin-computeruse's `getIosBridge`; that
 * package publishes `mobile/ios-bridge` as declarations only, so the lookup
 * is local rather than a runtime import.
 */
export function resolveIosComputerUseBridge(
	root: typeof globalThis = globalThis,
): IosBridge | null {
	const cap = (root as { Capacitor?: unknown }).Capacitor;
	if (!cap || typeof cap !== "object") return null;
	const plugins = (cap as { Plugins?: Record<string, unknown> }).Plugins;
	if (!plugins || typeof plugins !== "object") return null;
	const handle = plugins[IOS_COMPUTER_USE_PLUGIN];
	return handle ? (handle as IosBridge) : null;
}

export const APPLE_FOUNDATION_FAST_PATH_ENV =
	"ELIZA_APPLE_FOUNDATION_FAST_PATH";

/** Prompts longer than this stay on llama.cpp; the OS model is a short-turn tool. */
export const APPLE_FOUNDATION_MAX_PROMPT_CHARS = 4000;

/** Model types that may take the fast path; all others always use llama.cpp. */
export const APPLE_FOUNDATION_ELIGIBLE_MODEL_TYPES: ReadonlySet<string> =
	new Set([ModelType.TEXT_SMALL, ModelType.TEXT_COMPLETION]);

export type AppleFoundationRegistration =
	| { readonly outcome: "registered" }
	| {
			readonly outcome: "skipped";
			readonly reason:
				| "not_ios"
				| "bridge_unavailable"
				| "probe_failed"
				| "foundation_model_unavailable";
	  };

export function isAppleFoundationFastPathDisabledByEnv(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env[APPLE_FOUNDATION_FAST_PATH_ENV]?.trim().toLowerCase();
	return raw === "0" || raw === "false" || raw === "off";
}

/**
 * Register the adapter on an iOS host whose bridge reports Foundation Models
 * availability. The probe runs here, once, so the boot log states plainly why
 * the fast path is or is not active; `available()` on the adapter stays the
 * per-call guard afterwards.
 */
export async function tryRegisterAppleFoundationAdapter(args: {
	platform: string | undefined;
	getBridge: () => IosBridge | null;
	env?: NodeJS.ProcessEnv;
}): Promise<AppleFoundationRegistration> {
	if (args.platform !== "ios") return { outcome: "skipped", reason: "not_ios" };
	const bridge = args.getBridge();
	if (!bridge) return { outcome: "skipped", reason: "bridge_unavailable" };
	let probe: Awaited<ReturnType<IosBridge["probe"]>>;
	try {
		probe = await bridge.probe();
	} catch (error) {
		// error-policy:J4 user-facing degrade: a probe that throws means the
		// fast path is unavailable; llama.cpp stays the active handler.
		logger.warn(
			`[local-inference] Apple Foundation probe threw; fast path stays off: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { outcome: "skipped", reason: "probe_failed" };
	}
	if (!probe.ok) return { outcome: "skipped", reason: "probe_failed" };
	if (probe.data.capabilities.foundationModel !== true) {
		return { outcome: "skipped", reason: "foundation_model_unavailable" };
	}
	// The probe above already answered; seed the adapter with it so the first
	// eligible call is deterministic and the device is not probed a second time.
	registerAppleFoundationAdapter(
		createAppleFoundationAdapter(args.getBridge, { knownAvailable: true }),
	);
	logger.info(
		"[local-inference] Apple Foundation Models fast path registered (iOS 26 bridge reports foundationModel:true)",
	);
	return { outcome: "registered" };
}

/**
 * The adapter to use for this call, or `null` when llama.cpp must serve it.
 * Every structured-decoding or streaming feature the local engine honours is
 * a reason to decline: the OS model returns one plain completion.
 */
export function resolveAppleFoundationFastPath(
	modelType: string,
	params: GenerateTextParams,
	env: NodeJS.ProcessEnv = process.env,
): AppleFoundationAdapter | null {
	if (isAppleFoundationFastPathDisabledByEnv(env)) return null;
	if (!APPLE_FOUNDATION_ELIGIBLE_MODEL_TYPES.has(modelType)) return null;
	const adapter = getAppleFoundationAdapter();
	if (!adapter?.available()) return null;
	const prompt = params.prompt ?? "";
	if (
		prompt.length === 0 ||
		prompt.length > APPLE_FOUNDATION_MAX_PROMPT_CHARS
	) {
		return null;
	}
	if (params.stream === true || params.streamStructured === true) return null;
	if (typeof params.onStreamChunk === "function") return null;
	// Structured decoding, tool calling and schema-shaped output are llama.cpp
	// features; the OS model returns one plain completion.
	if (
		params.grammar !== undefined ||
		params.responseSkeleton !== undefined ||
		params.spanSamplerPlan !== undefined ||
		params.prefill !== undefined ||
		params.responseSchema !== undefined ||
		params.toolChoice !== undefined ||
		(params.tools !== undefined && params.tools.length > 0)
	) {
		return null;
	}
	// `omitMaxTokens` asks for no output cap; FoundationModelOptions defaults
	// maxTokens to 256 when unset, so the OS model would apply the tightest
	// cap in the system to the one call that opted out of caps.
	if (params.omitMaxTokens === true) return null;
	if (params.responseFormat !== undefined) {
		const format =
			typeof params.responseFormat === "string"
				? params.responseFormat
				: params.responseFormat.type;
		if (format !== "text") return null;
	}
	return adapter;
}

/**
 * Run one eligible call on the OS model and return its text, cut at the first
 * stop sequence. Every llama.cpp text route unions `ELIZA_TURN_STOP_SEQUENCES`
 * into the caller's stops so a completion never runs past the turn boundary;
 * `FoundationModelOptions` has no stop field, so the same invariant is applied
 * to the returned text here instead of at decode time.
 */
export async function generateWithAppleFoundation(
	adapter: AppleFoundationAdapter,
	params: GenerateTextParams,
): Promise<string> {
	const result = await adapter.generate({
		prompt: params.prompt ?? "",
		options: {
			...(params.maxTokens !== undefined
				? { maxTokens: params.maxTokens }
				: {}),
			...(params.temperature !== undefined
				? { temperature: params.temperature }
				: {}),
			...(params.system ? { instruction: params.system } : {}),
		},
	});
	logger.info(
		`[local-inference] apple-foundation served ${result.tokensIn}->${result.tokensOut} tokens in ${result.elapsedMs}ms`,
	);
	return truncateAtStopSequence(
		result.text,
		mergeElizaTurnStopSequences(params.stopSequences),
	);
}

/** The text before the earliest occurrence of any stop sequence (the text itself when none occurs). */
export function truncateAtStopSequence(
	text: string,
	stopSequences: readonly string[],
): string {
	let cut = text.length;
	for (const stop of stopSequences) {
		const index = text.indexOf(stop);
		if (index !== -1 && index < cut) cut = index;
	}
	return cut === text.length ? text : text.slice(0, cut);
}
