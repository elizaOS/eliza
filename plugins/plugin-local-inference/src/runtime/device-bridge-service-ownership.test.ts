/**
 * Replays the headless pre-init/post-init bridge order against a real runtime,
 * proving the local boot hook reuses the canonical service without a dead loader.
 */

import { AgentRuntime, ServiceType } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";
import { ensureLocalInferenceHandler } from "./ensure-local-inference-handler";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD:
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD,
	ELIZA_LOCAL_LLAMA: process.env.ELIZA_LOCAL_LLAMA,
};

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
delete process.env.ELIZA_LOCAL_LLAMA;

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("device bridge service ownership", () => {
	it("keeps the env-only provider unregistered through the post-init hook", async () => {
		const bridge = await import(
			"@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
		);
		const runtime = new AgentRuntime({ logLevel: "fatal" });

		try {
			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(runtime),
			).resolves.toBe(false);
			expect(runtime.hasService(ServiceType.MOBILE_DEVICE_BRIDGE)).toBe(true);

			await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
			await ensureLocalInferenceHandler(runtime);

			expect(
				runtime
					.getModelRegistrations()
					.filter((entry) => entry.provider === "eliza-device-bridge"),
			).toHaveLength(0);
			expect(runtime.hasService("localInferenceLoader")).toBe(false);
			expect(
				runtime.getService(ServiceType.MOBILE_DEVICE_BRIDGE),
			).toBeInstanceOf(bridge.CapacitorMobileDeviceBridgeService);
		} finally {
			await runtime.stop({ fast: true });
		}
	});
});
