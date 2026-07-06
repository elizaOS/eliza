/**
 * Pairing integration tests for channel connectors that gate DMs behind
 * `dmPolicy="pairing"`. The missing-service path must fail closed so a host
 * wiring mistake cannot silently turn pairing-gated DMs into open DMs.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../types";
import { ServiceType } from "../types/service";
import { checkPairingAllowed } from "./pairing-integration";

describe("checkPairingAllowed", () => {
	it("denies when PairingService is unavailable and reports the misconfiguration", async () => {
		const reportError = vi.fn();
		const runtime = {
			getService: vi.fn(() => null),
			logger: { warn: vi.fn() },
			reportError,
		} as unknown as IAgentRuntime;

		const result = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "1234567890",
		});

		expect(runtime.getService).toHaveBeenCalledWith(ServiceType.PAIRING);
		expect(result).toMatchObject({
			allowed: false,
			idLabel: "userId",
			replyMessage: "Access pairing is temporarily unavailable.",
		});
		// Systemic misconfiguration must reach the agent/owner, not just a log.
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError.mock.calls[0][0]).toBe("pairing-integration");
	});
});
