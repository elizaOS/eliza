// Item 35 (#12091): the mobile device bridge is modeled as a runtime Service
// (ServiceType.MOBILE_DEVICE_BRIDGE) registered by the mobile-host plugin and
// consumed via runtime.getService — NOT via the deleted core Symbol.for slot.
import { AgentRuntime, ServiceType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	CapacitorMobileDeviceBridgeService,
	mobileDeviceBridgePlugin,
} from "./index";

describe("mobile device bridge runtime service", () => {
	it("exposes the canonical serviceType and plugin registration", () => {
		expect(CapacitorMobileDeviceBridgeService.serviceType).toBe(
			ServiceType.MOBILE_DEVICE_BRIDGE,
		);
		expect(mobileDeviceBridgePlugin.services).toContain(
			CapacitorMobileDeviceBridgeService,
		);
	});

	it("registers on a real runtime under the canonical service type", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.registerPlugin(mobileDeviceBridgePlugin);

		// Proves the mobile host plugin registered a service that consumers can
		// resolve via runtime.getService(ServiceType.MOBILE_DEVICE_BRIDGE).
		expect(runtime.hasService(ServiceType.MOBILE_DEVICE_BRIDGE)).toBe(true);
		expect(runtime.getRegisteredServiceTypes()).toContain(
			ServiceType.MOBILE_DEVICE_BRIDGE,
		);
	});

	it("implements the typed bridge contract", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const svc = await CapacitorMobileDeviceBridgeService.start(runtime);
		expect(svc).toBeInstanceOf(CapacitorMobileDeviceBridgeService);

		const status = svc.getMobileDeviceBridgeStatus();
		expect(status).toBeDefined();
		expect(Array.isArray(status.devices)).toBe(true);
		expect(typeof status.connected).toBe("boolean");
		expect(typeof status.enabled).toBe("boolean");
	});
});
