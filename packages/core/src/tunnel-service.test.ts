/**
 * Unit tests for tunnel-service accessors.
 * Consolidated from colocated and __tests__/tunnel-service suites.
 * Preserves all unique assertions: null when missing, null when lacking
 * shape, valid service retrieval, ServiceType.TUNNEL call, and
 * tunnelSlotIsFree true/false.
 */
import { describe, expect, it, vi } from "vitest";
import {
	getTunnelService,
	type ITunnelService,
	tunnelSlotIsFree,
} from "./tunnel-service.js";
import { ServiceType } from "./types/service.js";

function runtimeWith(getService: (type: symbol) => unknown) {
	return { getService } as never;
}

const tunnel: Partial<ITunnelService> = {
	startTunnel: vi.fn(),
	stopTunnel: vi.fn(),
	getUrl: () => null,
	isActive: () => false,
	getStatus: () => ({
		active: false,
		url: null,
		port: null,
		startedAt: null,
		provider: "tailscale",
	}),
};

describe("getTunnelService", () => {
	it("returns the tunnel service when registered", () => {
		const getService = vi.fn(() => tunnel);
		expect(getTunnelService(runtimeWith(getService))).toBe(tunnel);
	});

	it("returns null when no tunnel service exists", () => {
		const getService = vi.fn(() => null);
		expect(getTunnelService(runtimeWith(getService))).toBeNull();
	});

	it("returns null when service lacks the tunnel shape", () => {
		const getService = vi.fn(() => ({}) as never);
		expect(getTunnelService(runtimeWith(getService))).toBeNull();
	});

	it("returns service when valid and verifies ServiceType.TUNNEL (merged from colocated)", () => {
		const svc = {
			startTunnel: async () => "url",
			stopTunnel: async () => {},
			getUrl: () => null,
			isActive: () => false,
			getStatus: () => ({}),
		};
		const runtime = { getService: vi.fn().mockReturnValue(svc) } as never;
		expect(getTunnelService(runtime)).toBe(svc as never);
		expect(runtime.getService).toHaveBeenCalledWith(ServiceType.TUNNEL);
	});
});

describe("tunnelSlotIsFree", () => {
	it("is true when no tunnel service is registered", () => {
		const getService = vi.fn(() => null);
		expect(tunnelSlotIsFree(runtimeWith(getService))).toBe(true);
	});

	it("is false when a tunnel service exists", () => {
		const getService = vi.fn(() => tunnel);
		expect(tunnelSlotIsFree(runtimeWith(getService))).toBe(false);
	});

	it("returns true via colocated helper when service missing (merged)", () => {
		const runtime = { getService: vi.fn().mockReturnValue(null) } as never;
		expect(getTunnelService(runtime)).toBeNull();
		expect(tunnelSlotIsFree(runtime)).toBe(true);
	});
});
