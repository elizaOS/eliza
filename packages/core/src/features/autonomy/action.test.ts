import { describe, expect, test } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import {
	disableAutonomousModeAction,
	enableAutonomousModeAction,
} from "./action";
import { AUTONOMY_SERVICE_TYPE } from "./service";

const MESSAGE = {
	id: "00000000-0000-0000-0000-000000000010" as UUID,
	entityId: "00000000-0000-0000-0000-000000000011" as UUID,
	agentId: "00000000-0000-0000-0000-000000000012" as UUID,
	roomId: "00000000-0000-0000-0000-000000000013" as UUID,
	content: { text: "" },
	createdAt: 1,
} satisfies Memory;

function makeAutonomyService() {
	let enabled = false;
	let running = false;
	return {
		enableAutonomy: async () => {
			enabled = true;
			running = true;
		},
		disableAutonomy: async () => {
			enabled = false;
			running = false;
		},
		getStatus: () => ({
			enabled,
			running,
			thinking: false,
			interval: 30000,
			autonomousRoomId:
				"00000000-0000-0000-0000-000000000014" as UUID,
		}),
	};
}

function makeRuntime(service: ReturnType<typeof makeAutonomyService> | null) {
	return {
		getService<T>(name: string): T | null {
			if (name === AUTONOMY_SERVICE_TYPE || name === "autonomy") {
				return service as T | null;
			}
			return null;
		},
	} as unknown as IAgentRuntime;
}

describe("autonomous mode control actions", () => {
	test("enable action is ADMIN gated and starts autonomy", async () => {
		const service = makeAutonomyService();
		const callbackCalls: unknown[] = [];

		expect(enableAutonomousModeAction.roleGate).toEqual({ minRole: "ADMIN" });
		expect(await enableAutonomousModeAction.validate?.(makeRuntime(service), MESSAGE)).toBe(
			true,
		);

		const result = await enableAutonomousModeAction.handler(
			makeRuntime(service),
			MESSAGE,
			undefined,
			undefined,
			async (content) => {
				callbackCalls.push(content);
				return [];
			},
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe("Autonomous mode enabled.");
		expect(result.data).toMatchObject({
			actionName: "ENABLE_AUTONOMOUS_MODE",
			enabled: true,
			running: true,
		});
		expect(callbackCalls).toHaveLength(1);
	});

	test("disable action is ADMIN gated and stops autonomy", async () => {
		const service = makeAutonomyService();
		await service.enableAutonomy();

		expect(disableAutonomousModeAction.roleGate).toEqual({ minRole: "ADMIN" });

		const result = await disableAutonomousModeAction.handler(
			makeRuntime(service),
			MESSAGE,
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe("Autonomous mode disabled.");
		expect(result.data).toMatchObject({
			actionName: "DISABLE_AUTONOMOUS_MODE",
			enabled: false,
			running: false,
		});
	});

	test("actions fail closed when autonomy service is unavailable", async () => {
		expect(await enableAutonomousModeAction.validate?.(makeRuntime(null), MESSAGE)).toBe(
			false,
		);

		const result = await enableAutonomousModeAction.handler(
			makeRuntime(null),
			MESSAGE,
		);

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			actionName: "ENABLE_AUTONOMOUS_MODE",
			errorCode: "autonomy_service_unavailable",
		});
	});
});
