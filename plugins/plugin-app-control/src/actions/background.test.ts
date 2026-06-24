import type { IAgentRuntime, Media, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundApplyPayload,
	createBackgroundAction,
	inferBackgroundPlan,
} from "./background.ts";

const runtime = {} as IAgentRuntime;

function message(text: string, attachments?: Media[]): Memory {
	return { content: { text, attachments } } as Memory;
}

describe("inferBackgroundPlan", () => {
	it("resolves a named color to a shader plan", () => {
		expect(inferBackgroundPlan("make the background teal", undefined)).toEqual({
			op: "set",
			mode: "shader",
			color: "#0891b2",
			colorLabel: "teal",
		});
	});

	it("resolves a hex color", () => {
		expect(
			inferBackgroundPlan("set the background to #123456", undefined),
		).toEqual({
			op: "set",
			mode: "shader",
			color: "#123456",
			colorLabel: "#123456",
		});
	});

	it("maps 'orange' to the brand default color", () => {
		const plan = inferBackgroundPlan("change the wallpaper to orange", undefined);
		expect(plan).toMatchObject({ op: "set", mode: "shader", color: "#ef5a1f" });
	});

	it("detects undo", () => {
		expect(inferBackgroundPlan("undo the background change", undefined)).toEqual({
			op: "undo",
		});
	});

	it("detects reset", () => {
		expect(
			inferBackgroundPlan("reset the background to default", undefined),
		).toEqual({ op: "reset" });
	});

	it("uses an image attachment as the background", () => {
		const plan = inferBackgroundPlan("set this as my background", [
			{ id: "a", url: "/api/media/abc.png", contentType: "image" } as Media,
		]);
		expect(plan).toEqual({
			op: "set",
			mode: "image",
			imageUrl: "/api/media/abc.png",
		});
	});

	it("generates from a description when no color resolves", () => {
		const plan = inferBackgroundPlan(
			"generate a misty forest background",
			undefined,
		);
		expect(plan).toMatchObject({ op: "set", generatePrompt: expect.any(String) });
		if (plan && "generatePrompt" in plan) {
			expect(plan.generatePrompt.toLowerCase()).toContain("misty forest");
		}
	});

	it("ignores chat that does not mention the background", () => {
		expect(inferBackgroundPlan("what is the weather today?", undefined)).toBeNull();
	});

	it("honors explicit options over text", () => {
		expect(
			inferBackgroundPlan("change my background", undefined, { color: "violet" }),
		).toMatchObject({ op: "set", mode: "shader", color: "#7c3aed" });
	});
});

describe("BACKGROUND action handler", () => {
	function setup() {
		const emitted: BackgroundApplyPayload[] = [];
		const replies: string[] = [];
		const action = createBackgroundAction({
			emit: async (payload) => {
				emitted.push(payload);
			},
			generateImage: async () => "/api/media/generated.png",
		});
		const callback = vi.fn(async (content: { text?: string }) => {
			if (content.text) replies.push(content.text);
			return [];
		});
		return { action, emitted, replies, callback };
	}

	it("broadcasts a shader color and confirms", async () => {
		const { action, emitted, replies, callback } = setup();
		const result = await action.handler(
			runtime,
			message("make the background blue"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([{ op: "set", mode: "shader", color: "#2563eb" }]);
		expect(result.success).toBe(true);
		expect(replies[0]).toContain("blue");
	});

	it("generates an image then broadcasts it", async () => {
		const { action, emitted, replies, callback } = setup();
		await action.handler(
			runtime,
			message("generate a calm beach background"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([
			{ op: "set", mode: "image", imageUrl: "/api/media/generated.png" },
		]);
		expect(replies[0].toLowerCase()).toContain("calm beach");
	});

	it("broadcasts undo", async () => {
		const { action, emitted } = setup();
		await action.handler(
			runtime,
			message("undo the background"),
			undefined,
			undefined,
			vi.fn(),
		);
		expect(emitted).toEqual([{ op: "undo" }]);
	});

	it("reports a clear error when the broadcast fails", async () => {
		const replies: string[] = [];
		const action = createBackgroundAction({
			emit: async () => {
				throw new Error("broadcast returned 500");
			},
		});
		const result = await action.handler(
			runtime,
			message("make the background green"),
			undefined,
			undefined,
			vi.fn(async (c: { text?: string }) => {
				if (c.text) replies.push(c.text);
				return [];
			}),
		);
		expect(result.success).toBe(false);
		expect(replies[0]).toContain("broadcast returned 500");
	});

	it("validates only actionable background requests", async () => {
		const { action } = setup();
		expect(await action.validate(runtime, message("make it teal"))).toBe(false);
		expect(
			await action.validate(runtime, message("make the background teal")),
		).toBe(true);
	});
});
