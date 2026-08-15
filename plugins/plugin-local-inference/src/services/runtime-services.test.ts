/**
 * Exercises local-inference service registration against a real AgentRuntime:
 * initialize, lazy start, synchronous discovery, and runtime-owned teardown.
 */

import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	LOCAL_INFERENCE_LOADER_SERVICE_TYPE,
	LocalInferenceLoaderRuntimeService,
	registerLocalInferenceLoaderService,
	registerTimedAsrService,
	TIMED_ASR_SERVICE_TYPE,
	TimedAsrService,
} from "./runtime-services";

describe("local-inference runtime services", () => {
	it("boots, resolves, and stops loader and timed-ASR services through AgentRuntime", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const loadModel = vi.fn(async () => undefined);
		const unloadModel = vi.fn(async () => undefined);
		const generate = vi.fn(async () => "local reply");
		const stopLoader = vi.fn(async () => undefined);

		try {
			// Registration is intentionally safe before initialize; waiting for
			// service startup here would deadlock on the runtime init barrier.
			await registerTimedAsrService(runtime);
			await registerLocalInferenceLoaderService(
				runtime,
				{
					loadModel,
					unloadModel,
					currentModelPath: () => "/models/eliza.gguf",
					generate,
				},
				{ stop: stopLoader },
			);
			await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

			expect(runtime.getService(TIMED_ASR_SERVICE_TYPE)).toBeNull();
			expect(
				runtime.getService(LOCAL_INFERENCE_LOADER_SERVICE_TYPE),
			).toBeNull();

			await runtime.getServiceLoadPromise(TIMED_ASR_SERVICE_TYPE);
			await runtime.getServiceLoadPromise(LOCAL_INFERENCE_LOADER_SERVICE_TYPE);

			const timedAsr = runtime.getService<TimedAsrService>(
				TIMED_ASR_SERVICE_TYPE,
			);
			const loader = runtime.getService<LocalInferenceLoaderRuntimeService>(
				LOCAL_INFERENCE_LOADER_SERVICE_TYPE,
			);
			expect(timedAsr).toBeInstanceOf(TimedAsrService);
			expect(loader).toBeInstanceOf(LocalInferenceLoaderRuntimeService);
			if (!loader?.generate) {
				throw new Error("local inference loader did not expose generation");
			}
			expect(loader?.embed).toBeUndefined();

			await loader.loadModel({ modelPath: "/models/eliza.gguf" });
			await expect(loader.generate({ prompt: "hello" })).resolves.toBe(
				"local reply",
			);
			expect(loadModel).toHaveBeenCalledWith({
				modelPath: "/models/eliza.gguf",
			});

			await runtime.stop();
			expect(stopLoader).toHaveBeenCalledTimes(1);
			expect(unloadModel).not.toHaveBeenCalled();
		} finally {
			await runtime.stop({ fast: true });
		}
	});
});
