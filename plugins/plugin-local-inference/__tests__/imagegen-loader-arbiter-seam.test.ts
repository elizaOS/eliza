/**
 * WS3 production-wiring seam: the runtime registers a `localInferenceLoader`
 * runtime service (see `runtime/ensure-local-inference-handler.ts`). The
 * provider's `tryGetImageGenArbiter` looks for `service.getMemoryArbiter()`
 * on that registered loader, NOT on the module-level `localInferenceService`
 * singleton. The two are different objects.
 *
 * Until the audit caught this, `registerDeviceBridgeLoader` registered the
 * loader without a `getMemoryArbiter` accessor — so even though the WS3
 * capability was registered with the process-wide arbiter, the IMAGE handler
 * unconditionally surfaced `capability_unavailable` because the runtime
 * service it walked through had no arbiter accessor.
 *
 * This test pins the seam: build a fake runtime, register the loader the
 * way the real wiring does (via `registerDeviceBridgeLoader`'s
 * `Object.assign(loader, { getMemoryArbiter: () => tryGetMemoryArbiter() })`),
 * register an image-gen capability, then verify the IMAGE handler returns
 * a valid PNG data URL.
 */

import { describe, expect, it } from "vitest";
import { ModelType } from "@elizaos/core";
import {
	MemoryArbiter,
	setMemoryArbiter,
	tryGetMemoryArbiter,
} from "../src/services/memory-arbiter";
import { SharedResourceRegistry } from "../src/services/voice/shared-resources";
import {
	createImageGenCapabilityRegistration,
	type ImageGenBackend,
	type ImageGenResult,
} from "../src/services/imagegen";
import { createLocalInferenceModelHandlers } from "../src/provider";

const FAKE_PNG: Uint8Array = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
	0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05,
	0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
function fakeBackend(): ImageGenBackend {
	return {
		id: "fake",
		supports: () => true,
		async generate(req): Promise<ImageGenResult> {
			return {
				image: FAKE_PNG,
				mime: "image/png",
				seed: typeof req.seed === "number" ? req.seed : 0,
				metadata: {
					model: "imagegen-fake",
					prompt: req.prompt,
					steps: req.steps ?? 1,
					guidanceScale: 0,
					inferenceTimeMs: 1,
				},
			};
		},
		async dispose() {},
	};
}

describe("WS3 provider/loader arbiter accessor seam", () => {
	it("IMAGE handler reaches the arbiter through the registered loader's getMemoryArbiter()", async () => {
		// Build the process-wide arbiter the way LocalInferenceService does.
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry });
		arbiter.start();
		setMemoryArbiter(arbiter);
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => fakeBackend(),
			}),
		);

		// Mimic `registerDeviceBridgeLoader`: the registered service is a
		// `LocalInferenceLoader` augmented with a `getMemoryArbiter()` that
		// returns the singleton. This is what `provider.ts#tryGetImageGenArbiter`
		// drills into.
		const loader = {
			loadModel: async () => undefined,
			unloadModel: async () => undefined,
			currentModelPath: () => null,
			getMemoryArbiter: () => tryGetMemoryArbiter(),
		};

		const runtime = {
			getService: (name: string) =>
				name === "localInferenceLoader" ? loader : null,
			getSetting: () => undefined,
			setSetting: () => undefined,
		};

		const handlers = createLocalInferenceModelHandlers();
		// biome-ignore lint/style/noNonNullAssertion: handler is registered.
		const handler = handlers[ModelType.IMAGE]!;
		// biome-ignore lint/suspicious/noExplicitAny: test runtime stand-in.
		const result = (await handler(runtime as any, {
			prompt: "a forest at dawn",
			size: "512x512",
			count: 1,
		})) as { url: string }[];

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(1);
		expect(result[0].url).toMatch(/^data:image\/png;base64,/);
		await arbiter.shutdown();
		setMemoryArbiter(null);
	});

	it("surfaces capability_unavailable when the loader exposes getMemoryArbiter but image-gen is not registered", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry });
		arbiter.start();
		setMemoryArbiter(arbiter);
		// Intentionally do NOT register image-gen.

		const loader = {
			loadModel: async () => undefined,
			unloadModel: async () => undefined,
			currentModelPath: () => null,
			getMemoryArbiter: () => tryGetMemoryArbiter(),
		};
		const runtime = {
			getService: (name: string) =>
				name === "localInferenceLoader" ? loader : null,
			getSetting: () => undefined,
			setSetting: () => undefined,
		};
		const handlers = createLocalInferenceModelHandlers();
		// biome-ignore lint/style/noNonNullAssertion: handler is registered.
		const handler = handlers[ModelType.IMAGE]!;

		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: test runtime stand-in.
			handler(runtime as any, { prompt: "x" }),
		).rejects.toThrow(/capability_unavailable|IMAGE generation requires/);

		await arbiter.shutdown();
		setMemoryArbiter(null);
	});
});
