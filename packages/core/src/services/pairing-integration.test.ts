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
	it("denies when PairingService is unavailable", async () => {
		const runtime = {
			getService: vi.fn(() => null),
			logger: { warn: vi.fn() },
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
	});
});
