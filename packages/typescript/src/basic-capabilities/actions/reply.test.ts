import { describe, expect, it, vi } from "vitest";
import { replyAction } from "./reply";

describe("replyAction", () => {
	it("returns the generated reply text without an internal prefix", async () => {
		const callback = vi.fn();
		const composeState = vi.fn().mockResolvedValue({
			values: {},
			data: {},
			text: "",
		});
		const useModel = vi
			.fn()
			.mockResolvedValue(
				"<response><thought>thinking</thought><text>Hello world</text></response>",
			);

		const runtime = {
			agentId: "agent-1",
			character: {
				templates: {},
			},
			composeState,
			useModel,
		};

		const message = {
			content: {
				text: "hi",
			},
		};

		const result = await replyAction.handler(
			runtime as never,
			message as never,
			undefined,
			undefined,
			callback,
			[],
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith({
			thought: "thinking",
			text: "Hello world",
			actions: ["REPLY"],
		});
		expect(result.text).toBe("Hello world");
		expect(result.data?.messageGenerated).toBe(true);
	});
});
