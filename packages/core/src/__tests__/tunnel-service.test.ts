import { describe, expect, it, vi } from "vitest";
import {
	getTunnelService,
	type ITunnelService,
	tunnelSlotIsFree,
} from "../tunnel-service.ts";

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

	it("returns null when the service lacks the tunnel shape", () => {
		const getService = vi.fn(() => ({}) as never);
		expect(getTunnelService(runtimeWith(getService))).toBeNull();
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
});
