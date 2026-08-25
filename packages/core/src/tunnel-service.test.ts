import { describe, expect, it, vi } from "vitest";
import { getTunnelService, tunnelSlotIsFree } from "./tunnel-service.js";
import { ServiceType } from "./types/service.js";

describe("tunnel-service", () => {
	it("returns null when service missing", () => {
		const runtime = { getService: vi.fn().mockReturnValue(null) } as never;
		expect(getTunnelService(runtime)).toBeNull();
		expect(tunnelSlotIsFree(runtime)).toBe(true);
	});

	it("returns null when service lacks startTunnel", () => {
		const runtime = { getService: vi.fn().mockReturnValue({}) } as never;
		expect(getTunnelService(runtime)).toBeNull();
	});

	it("returns service when valid and slot not free", () => {
		const svc = {
			startTunnel: async () => "url",
			stopTunnel: async () => {},
			getUrl: () => null,
			isActive: () => false,
			getStatus: () => ({}),
		};
		const runtime = { getService: vi.fn().mockReturnValue(svc) } as never;
		expect(getTunnelService(runtime)).toBe(svc as never);
		expect(tunnelSlotIsFree(runtime)).toBe(false);
		expect(runtime.getService).toHaveBeenCalledWith(ServiceType.TUNNEL);
	});
});
