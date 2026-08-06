/**
 * Verifies that security assessment failures remain visible to state composition
 * instead of being misreported as a successful no-threat result. Uses a typed
 * mock runtime and security service; no live model or database.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { securityStatusProvider } from "./securityStatus.ts";

const USER_ID = "10000000-0000-0000-0000-000000000000" as UUID;
const ROOM_ID = "20000000-0000-0000-0000-000000000000" as UUID;

describe("securityStatusProvider", () => {
	test("reports security service failures as unavailable, never no-threat", async () => {
		const failure = new Error("security backend offline");
		const assessThreatLevel = vi.fn();
		const getRecentSecurityIncidents = vi.fn();
		const securityModule = {
			analyzeMessage: vi.fn().mockRejectedValue(failure),
			assessThreatLevel,
			getRecentSecurityIncidents,
		};
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			getService: (() => securityModule) as IAgentRuntime["getService"],
			getSetting: () => undefined,
			getRoom: async () => null,
			reportError,
		});
		const message = {
			agentId: runtime.agentId,
			entityId: USER_ID,
			roomId: ROOM_ID,
			content: { text: "hello" },
		} as Memory;

		const result = await securityStatusProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toContain("assessment unavailable");
		expect(result.values).toEqual({
			securityConcern: "unavailable",
			alertLevel: "UNKNOWN",
		});
		expect(result.values).not.toHaveProperty("hasActiveThreats");
		expect(result.values).not.toHaveProperty("currentMessageFlagged");
		expect(result.data).toMatchObject({ available: false });
		expect(reportError).toHaveBeenCalledWith(
			"SecurityStatusProvider.get",
			failure,
			{ roomId: ROOM_ID, entityId: USER_ID },
		);
		expect(getRecentSecurityIncidents).not.toHaveBeenCalled();
		expect(assessThreatLevel).not.toHaveBeenCalled();
	});
});
