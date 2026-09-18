/** Exercises tunnel lookup and slot admission with typed service doubles. */
import { describe, expect, it, vi } from "vitest";
import {
	getTunnelService,
	type ITunnelService,
	tunnelSlotIsFree,
} from "./tunnel-service.js";
import type { IAgentRuntime } from "./types/runtime.js";
import { Service, ServiceType } from "./types/service.js";

class RegisteredService extends Service {
	capabilityDescription = "test service";
	async stop() {}
}

const tunnel = Object.assign(new RegisteredService(), {
	startTunnel: async () => "https://tunnel.example.test",
	stopTunnel: async () => {},
	getUrl: () => null,
	isActive: () => false,
	getStatus: () => ({
		active: false,
		url: null,
		port: null,
		startedAt: null,
		provider: "tailscale" as const,
	}),
} satisfies ITunnelService);

describe("tunnel service admission", () => {
	it.each([
		{ name: "missing", service: null, expected: null, free: true },
		{
			name: "registered without tunnel support",
			service: new RegisteredService(),
			expected: null,
			free: false,
		},
		{
			name: "registered tunnel",
			service: tunnel,
			expected: tunnel,
			free: false,
		},
	])(
		"resolves $name without claiming an occupied slot",
		({ service, expected, free }) => {
			const getService = vi
				.fn<IAgentRuntime["getService"]>()
				.mockReturnValue(service);
			const runtime = { getService };
			expect(getTunnelService(runtime)).toBe(expected);
			expect(tunnelSlotIsFree(runtime)).toBe(free);
			expect(getService).toHaveBeenCalledWith(ServiceType.TUNNEL);
		},
	);
});
