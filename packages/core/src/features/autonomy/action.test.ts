/**
 * Unit test for the autonomy capability's ESCALATE action, covering the
 * escalation targets it does not implement. Drives `escalateAction.handler`
 * directly with cast-empty runtime/memory (no model, no service), asserting that
 * `owner` and `third_party` targets fail with the `unsupported_escalation_target`
 * error code rather than silently succeeding.
 */
import { describe, expect, it, vi } from "vitest";
import type { HandlerCallback, IAgentRuntime, Memory, UUID } from "../../types";
import { stringToUuid } from "../../utils";
import { escalateAction } from "./action";
import { AUTONOMY_SERVICE_TYPE } from "./service";

const agentId = stringToUuid("agent") as UUID;
const autonomousRoomId = stringToUuid("autonomous-room") as UUID;

function autonomousMessage(text: string): Memory {
	return {
		id: stringToUuid(`message-${text}`),
		entityId: agentId,
		roomId: autonomousRoomId,
		content: { text },
	};
}

function runtimeWithAdmin(captured: Memory[]): IAgentRuntime {
	return {
		agentId,
		getService: vi.fn((serviceType: string) =>
			serviceType === AUTONOMY_SERVICE_TYPE
				? { getAutonomousRoomId: () => autonomousRoomId }
				: null,
		),
		getSetting: vi.fn((key: string) =>
			key === "ADMIN_USER_ID" ? "admin-user" : undefined,
		),
		createMemory: vi.fn(async (memory: Memory) => {
			captured.push(memory);
			return undefined;
		}),
	} as unknown as IAgentRuntime;
}

describe("escalateAction", () => {
	it.each([
		"owner",
		"third_party",
	] as const)("returns an unsupported-target result for %s escalation", async (action) => {
		const result = await escalateAction.handler(
			{} as IAgentRuntime,
			{} as Memory,
			undefined,
			{ parameters: { action } },
		);

		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			actionName: "ESCALATE",
			action,
			errorCode: "unsupported_escalation_target",
		});
		expect(result.text).toContain("not supported");
	});

	it("sends the model-authored escalation message when provided", async () => {
		const captured: Memory[] = [];
		const callback = vi.fn() as HandlerCallback;
		const result = await escalateAction.handler(
			runtimeWithAdmin(captured),
			autonomousMessage("Internal thought that should remain metadata."),
			undefined,
			{
				parameters: {
					action: "admin",
					message: "Please review the delivery plan before I proceed.",
				},
			},
			callback,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			adminUserId: "admin-user",
			targetRoomId: agentId,
			messageContent: "Please review the delivery plan before I proceed.",
			sent: true,
			action: "admin",
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]?.roomId).toBe(agentId);
		expect(captured[0]?.content.text).toBe(
			"Please review the delivery plan before I proceed.",
		);
		expect(captured[0]?.content.metadata).toMatchObject({
			type: "autonomous-to-admin-message",
			originalThought: "Internal thought that should remain metadata.",
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					messageContent: "Please review the delivery plan before I proceed.",
				}),
			}),
		);
	});

	it("falls back to the autonomous thought verbatim without keyword framing", async () => {
		const captured: Memory[] = [];
		const thought =
			"No problems encountered; all finished, but I have a question.";
		const result = await escalateAction.handler(
			runtimeWithAdmin(captured),
			autonomousMessage(thought),
			undefined,
			{ parameters: { action: "admin" } },
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			messageContent: thought,
			targetRoomId: agentId,
		});
		expect(captured[0]?.content.text).toBe(thought);
		expect(captured[0]?.content.text).not.toContain("I've completed a task");
		expect(captured[0]?.content.text).not.toContain(
			"might need your attention",
		);
	});
});
