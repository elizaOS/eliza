/**
 * Exercises Capacitor bridge ownership across two real AgentRuntime instances.
 * The HTTP server is intentionally unbound: only listener and service lifecycle
 * are under test, so no TCP port is opened.
 */

import http from "node:http";
import { AgentRuntime, ServiceType } from "@elizaos/core";
import { afterAll, describe, expect, it, vi } from "vitest";

const savedEnv = {
	ELIZA_DEVICE_BRIDGE_ENABLED: process.env.ELIZA_DEVICE_BRIDGE_ENABLED,
	ELIZA_DEVICE_PAIRING_TOKEN: process.env.ELIZA_DEVICE_PAIRING_TOKEN,
	ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD:
		process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD,
	ELIZA_LOCAL_LLAMA: process.env.ELIZA_LOCAL_LLAMA,
};

process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
process.env.ELIZA_DEVICE_PAIRING_TOKEN = "runtime-replacement-ownership";
process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD = "1";
delete process.env.ELIZA_LOCAL_LLAMA;

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("mobile device bridge runtime replacement ownership", () => {
	it("does not install an attach listener after plugin registration loses to stop", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const registerPlugin = runtime.registerPlugin.bind(runtime);
		const registrationSpy = vi
			.spyOn(runtime, "registerPlugin")
			.mockImplementation(async (plugin) => {
				await registerPlugin(plugin);
				await runtime.stop({ fast: true });
			});
		const attachableBridge = bridge.mobileDeviceBridge as unknown as {
			notifyDeviceAttached(): void;
		};

		try {
			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(runtime),
			).resolves.toBe(false);
			attachableBridge.notifyDeviceAttached();

			expect(
				runtime
					.getModelRegistrations()
					.filter((entry) => entry.provider === "capacitor-llama"),
			).toHaveLength(0);
		} finally {
			registrationSpy.mockRestore();
			await runtime.stop({ fast: true });
			await bridge.mobileDeviceBridge.close();
		}
	});

	it("fails closed when the plugin name is owned without the bridge service", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const foreignPlugin = {
			name: "capacitor-bridge",
			description: "Unrelated plugin holding the bridge package name",
		};
		const attachableBridge = bridge.mobileDeviceBridge as unknown as {
			notifyDeviceAttached(): void;
		};

		try {
			await runtime.registerPlugin(foreignPlugin);
			const foreignOwnership = runtime.getPluginOwnership(foreignPlugin.name);
			expect(foreignOwnership?.services).toHaveLength(0);

			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(runtime),
			).resolves.toBe(false);
			expect(runtime.getPluginOwnership(foreignPlugin.name)).toBe(
				foreignOwnership,
			);
			expect(runtime.plugins).toContain(foreignPlugin);
			expect(runtime.getRegisteredServiceTypes()).not.toContain(
				ServiceType.MOBILE_DEVICE_BRIDGE,
			);

			await runtime.stop({ fast: true });
			attachableBridge.notifyDeviceAttached();
			expect(
				runtime
					.getModelRegistrations()
					.filter((entry) => entry.provider === "capacitor-llama"),
			).toHaveLength(0);
		} finally {
			await runtime.stop({ fast: true });
			await bridge.mobileDeviceBridge.close();
		}
	});

	it("removes a stopped pre-init runtime listener without touching its successor", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const stoppedRuntime = new AgentRuntime({ logLevel: "fatal" });
		const successorRuntime = new AgentRuntime({ logLevel: "fatal" });
		const attachableBridge = bridge.mobileDeviceBridge as unknown as {
			notifyDeviceAttached(): void;
		};

		try {
			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(stoppedRuntime),
			).resolves.toBe(false);
			await expect(
				bridge.ensureMobileDeviceBridgeInferenceHandlers(successorRuntime),
			).resolves.toBe(false);

			await stoppedRuntime.stop({ fast: true });
			await stoppedRuntime.stop({ fast: true });
			attachableBridge.notifyDeviceAttached();

			expect(
				stoppedRuntime
					.getModelRegistrations()
					.filter((entry) => entry.provider === "capacitor-llama"),
			).toHaveLength(0);
			expect(
				successorRuntime
					.getModelRegistrations()
					.filter((entry) => entry.provider === "capacitor-llama"),
			).toHaveLength(3);
		} finally {
			await stoppedRuntime.stop({ fast: true });
			await successorRuntime.stop({ fast: true });
			await bridge.mobileDeviceBridge.close();
		}
	});

	it("keeps the shared server transport alive when the old runtime stops", async () => {
		const bridge = await import("./mobile-device-bridge-bootstrap");
		const server = http.createServer();
		const previousRuntime = new AgentRuntime({ logLevel: "fatal" });
		const replacementRuntime = new AgentRuntime({ logLevel: "fatal" });

		try {
			await bridge.ensureMobileDeviceBridgeInferenceHandlers(previousRuntime);
			await previousRuntime.initialize({
				allowNoDatabase: true,
				skipMigrations: true,
			});
			await previousRuntime.getServiceLoadPromise(
				ServiceType.MOBILE_DEVICE_BRIDGE,
			);
			await bridge.attachMobileDeviceBridgeToServer(server);

			await bridge.ensureMobileDeviceBridgeInferenceHandlers(
				replacementRuntime,
			);
			await replacementRuntime.initialize({
				allowNoDatabase: true,
				skipMigrations: true,
			});
			await replacementRuntime.getServiceLoadPromise(
				ServiceType.MOBILE_DEVICE_BRIDGE,
			);

			expect(server.listenerCount("upgrade")).toBe(1);
			await previousRuntime.stop({ fast: true });

			expect(server.listenerCount("upgrade")).toBe(1);
			expect(
				replacementRuntime.getService(ServiceType.MOBILE_DEVICE_BRIDGE),
			).toBeInstanceOf(bridge.CapacitorMobileDeviceBridgeService);

			// A real server close event owns final transport teardown. Emitting it on
			// this deliberately unbound server proves the ownership boundary without
			// opening a TCP listener.
			server.emit("close");
			expect(server.listenerCount("upgrade")).toBe(0);
		} finally {
			await previousRuntime.stop({ fast: true });
			await replacementRuntime.stop({ fast: true });
			await bridge.mobileDeviceBridge.close();
		}
	});
});
