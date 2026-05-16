import { logger } from "@elizaos/core";
import { localInferenceEngine } from "./engine";

let activeVoicePrewarm:
	| { modelId: string; promise: Promise<boolean> }
	| null = null;

export function shouldPrewarmLocalVoiceStack(modelId: string): boolean {
	return /^eliza-1(?:-|$)/.test(modelId);
}

export async function prewarmLocalVoiceStackForModel(
	modelId: string,
): Promise<boolean> {
	if (!shouldPrewarmLocalVoiceStack(modelId)) return false;
	if (activeVoicePrewarm?.modelId === modelId) {
		return activeVoicePrewarm.promise;
	}

	const started = Date.now();
	const promise = (async () => {
		await localInferenceEngine.ensureActiveBundleVoiceReady();
		await localInferenceEngine.transcribePcm({
			pcm: new Float32Array(4000),
			sampleRate: 16_000,
		});
		await localInferenceEngine.synthesizeSpeech("Hello.");
		return true;
	})()
		.then((warmed) => {
			logger.info(
				`[local-inference] Prewarmed local voice stack for ${modelId} in ${Date.now() - started}ms`,
			);
			return warmed;
		})
		.catch((err) => {
			logger.warn(
				`[local-inference] Local voice prewarm failed for ${modelId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return false;
		})
		.finally(() => {
			if (activeVoicePrewarm?.promise === promise) {
				activeVoicePrewarm = null;
			}
		});

	activeVoicePrewarm = { modelId, promise };
	return promise;
}
