import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import transferAction from "../actions/transfer";
import { getWalletKey } from "../keypairUtils";

vi.mock("../keypairUtils", () => ({
	getWalletKey: vi.fn(),
}));

function createRuntime(): IAgentRuntime {
	return {
		useModel: vi.fn(async () =>
			JSON.stringify({
				tokenAddress: null,
				recipient: "11111111111111111111111111111111",
				amount: "0.01",
			}),
		),
		getSetting: vi.fn(),
	} as unknown as IAgentRuntime;
}

function createMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		agentId: "test-agent",
		content: { text: "Send 0.01 SOL to 11111111111111111111111111111111" },
	} as unknown as Memory;
}

function createState(): State {
	return { values: {}, data: { providers: {} } } as State;
}

describe("Solana transaction confirmation gates", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("previews transfers without loading signing keys when confirmed is absent", async () => {
		const callback = vi.fn(async () => []);

		const result = await transferAction.handler(
			createRuntime(),
			createMessage(),
			createState(),
			{},
			callback as HandlerCallback,
		);

		expect(result?.success).toBe(false);
		expect(result?.data?.requiresConfirmation).toBe(true);
		expect(result?.data?.preview).toContain("Review Solana transfer");
		expect(result?.data?.confirmation).toMatchObject({
			actionName: transferAction.name,
			confirmed: false,
			parameters: {
				tokenAddress: null,
				recipient: "11111111111111111111111111111111",
				amount: "0.01",
				confirmed: true,
			},
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("confirmed: true"),
			}),
		);
		expect(vi.mocked(getWalletKey)).not.toHaveBeenCalled();
	});
});
