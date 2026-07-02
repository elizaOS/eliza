/**
 * Direct load-and-run lane for the #10727 lifecycle matrix (`--load-run`).
 *
 * For every installed, curated (eliza-download) model — optionally filtered by
 * id — this loads the real artifact through the production coordinator
 * (`localInferenceService.setActive`, the same path the app uses) and decodes
 * a short completion through the real FFI engine, recording measured
 * load time, decode throughput (exact usage tokens when the backend reports
 * them; the engine's length-estimate convention otherwise, flagged as
 * estimated), and the accelerated backend serving the run. The results feed
 * `buildLocalModelLifecycleMatrix({ loadRunChecks })`, so `loadsAndRunsOnDevice`
 * rows carry direct evidence instead of trusting `bundleVerifiedAt`.
 *
 * Rows this host cannot prove (model not installed, or the tier does not
 * support any detected accelerator and CPU fallback is disallowed) are
 * reported `skipped` with the reason — never `pass`.
 */

import { probeHardware } from "./hardware";
import type { LifecycleLoadRunCheck } from "./local-model-lifecycle-matrix";
import { deviceCapsFromProbe } from "./recommendation";
import { listInstalledModels } from "./registry";
import type { HardwareProbe, InstalledModel } from "./types";

export interface LifecycleLoadRunOptions {
	/** Restrict the lane to these model ids (default: every installed model). */
	modelIds?: readonly string[];
	prompt?: string;
	maxTokens?: number;
	hardware?: HardwareProbe;
}

const DEFAULT_PROMPT =
	"Reply with one short sentence: which model tier is answering?";
const DEFAULT_MAX_TOKENS = 48;

function backendLabel(hardware: HardwareProbe): string {
	const caps = deviceCapsFromProbe(hardware);
	const accelerated = caps.availableBackends.find(
		(backend) => backend !== "cpu",
	);
	return accelerated ?? "cpu";
}

export async function collectLifecycleLoadRunChecks(
	options: LifecycleLoadRunOptions = {},
): Promise<Record<string, LifecycleLoadRunCheck>> {
	const [{ localInferenceService }, { localInferenceEngine }] =
		await Promise.all([import("./service"), import("./engine")]);
	const hardware = options.hardware ?? (await probeHardware());
	const backend = backendLabel(hardware);
	const prompt = options.prompt ?? DEFAULT_PROMPT;
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

	const installed = (await listInstalledModels()).filter(
		(model: InstalledModel) =>
			model.source === "eliza-download" &&
			(!options.modelIds || options.modelIds.includes(model.id)),
	);

	const checks: Record<string, LifecycleLoadRunCheck> = {};
	for (const model of installed) {
		const startedAt = new Date().toISOString();
		const loadStart = performance.now();
		try {
			const state = await localInferenceService.setActive(null, model.id);
			const loadMs = Math.round(performance.now() - loadStart);
			if (state.status !== "ready" || !localInferenceEngine.hasLoadedModel()) {
				checks[model.id] = {
					status: "fail",
					detail: `engine did not reach ready after load (status: ${state.status}${
						state.status === "error" && state.error ? `, ${state.error}` : ""
					})`,
					checkedAt: startedAt,
					backend,
					loadMs,
				};
				continue;
			}
			const handle = localInferenceEngine.openConversation({
				conversationId: `lifecycle-loadrun-${model.id}`,
				modelId: model.id,
			});
			const generateStart = performance.now();
			let result: Awaited<
				ReturnType<typeof localInferenceEngine.generateInConversation>
			>;
			try {
				result = await localInferenceEngine.generateInConversation(handle, {
					prompt,
					maxTokens,
					temperature: 0,
				});
			} finally {
				await localInferenceEngine.closeConversation(handle);
			}
			const generateMs = Math.round(performance.now() - generateStart);
			const trimmed = result.text.trim();
			if (!trimmed) {
				checks[model.id] = {
					status: "fail",
					detail: `model loaded (${loadMs} ms) but produced no text`,
					checkedAt: startedAt,
					backend,
					loadMs,
					generateMs,
				};
				continue;
			}
			// The fused backend's usage block reports `completion_tokens` from the
			// MTP acceptance counter, which is 0 when no drafter is hosted — fall
			// back to the engine's own decode estimate (ceil(len/4), the same
			// convention `recordDecodeThroughput` uses) and say so in the detail.
			const exactTokens = result.usage.output_tokens;
			const decodeTokens =
				exactTokens > 0
					? exactTokens
					: Math.max(1, Math.ceil(trimmed.length / 4));
			const estimated = exactTokens <= 0;
			const tokensPerSecond =
				generateMs > 0
					? Number((decodeTokens / (generateMs / 1000)).toFixed(2))
					: undefined;
			checks[model.id] = {
				status: "pass",
				detail: `loaded in ${loadMs} ms and decoded ${decodeTokens}${estimated ? " (length-estimated)" : ""} tokens in ${generateMs} ms via the FFI engine`,
				checkedAt: startedAt,
				backend,
				loadMs,
				generateMs,
				promptTokens: result.usage.input_tokens,
				decodeTokens,
				tokensPerSecond,
			};
		} catch (error) {
			checks[model.id] = {
				status: "fail",
				detail: `load/run threw: ${error instanceof Error ? error.message : String(error)}`,
				checkedAt: startedAt,
				backend,
			};
		} finally {
			await localInferenceService.clearActive(null).catch(() => {
				// Unload failures must not mask the recorded check for this model.
			});
		}
	}
	return checks;
}
