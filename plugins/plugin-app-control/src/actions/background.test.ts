/**
 * BACKGROUND action tests for plan inference and renderer broadcast payloads.
 */

import type { IAgentRuntime, Media, Memory } from "@elizaos/core";
import type { NavigateViewDetail } from "@elizaos/shared/events";
import { BACKGROUND_APPLY_EVENT as SHARED_BACKGROUND_APPLY_EVENT } from "@elizaos/shared/events";
import { describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_APPLY_EVENT,
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
		const plan = inferBackgroundPlan(
			"change the wallpaper to orange",
			undefined,
		);
		expect(plan).toMatchObject({ op: "set", mode: "shader", color: "#ef5a1f" });
	});

	it("detects undo", () => {
		expect(
			inferBackgroundPlan("undo the background change", undefined),
		).toEqual({
			op: "undo",
		});
	});

	it("detects redo", () => {
		expect(
			inferBackgroundPlan("redo the background change", undefined),
		).toEqual({
			op: "redo",
		});
	});

	it("detects redo from a 'go forward' phrasing", () => {
		expect(
			inferBackgroundPlan("go forward on the background", undefined),
		).toEqual({ op: "redo" });
	});

	it("resolves a color word like 'red' to a set, not redo", () => {
		expect(inferBackgroundPlan("make the background red", undefined)).toEqual({
			op: "set",
			mode: "shader",
			color: "#dc2626",
			colorLabel: "red",
		});
	});

	it("detects reset", () => {
		expect(
			inferBackgroundPlan("reset the background to default", undefined),
		).toEqual({ op: "reset" });
	});

	it("detects undo from surface-named 'put … back' phrasings (#11360)", () => {
		expect(inferBackgroundPlan("put the background back", undefined)).toEqual({
			op: "undo",
		});
		expect(inferBackgroundPlan("put the wallpaper back", undefined)).toEqual({
			op: "undo",
		});
		expect(
			inferBackgroundPlan("switch back the background", undefined),
		).toEqual({ op: "undo" });
	});

	it("detects undo from 'revert the wallpaper' (#11360)", () => {
		expect(inferBackgroundPlan("revert the wallpaper", undefined)).toEqual({
			op: "undo",
		});
	});

	it("detects reset from 'restore/back to the original' (#11360)", () => {
		expect(
			inferBackgroundPlan("restore the original background", undefined),
		).toEqual({ op: "reset" });
		expect(
			inferBackgroundPlan("put the background back to the original", undefined),
		).toEqual({ op: "reset" });
	});

	it("'go back to the default look' is reset, not undo", () => {
		expect(
			inferBackgroundPlan("go back to the default background look", undefined),
		).toEqual({ op: "reset" });
	});

	it("scenario phrasing 'reset the background to the default look' is reset", () => {
		expect(
			inferBackgroundPlan(
				"reset the background to the default look",
				undefined,
			),
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

	it("does not throw on attachment records without a URL", () => {
		expect(() =>
			inferBackgroundPlan("set the background from this attachment", [
				{} as Media,
			]),
		).not.toThrow();
	});

	it("does not generate when attachment intent has no usable image URL", () => {
		expect(
			inferBackgroundPlan("set the background from this attachment", [
				{ contentType: "image" } as Media,
			]),
		).toBeNull();
		expect(
			inferBackgroundPlan("use this uploaded file as my background", [
				{ url: null, contentType: "image" } as unknown as Media,
			]),
		).toBeNull();
		expect(
			inferBackgroundPlan("put that file on the background", [
				{ url: 123, contentType: "image" } as unknown as Media,
			]),
		).toBeNull();
	});

	it("generates from a description when no color resolves", () => {
		const plan = inferBackgroundPlan(
			"generate a misty forest background",
			undefined,
		);
		expect(plan).toMatchObject({
			op: "set",
			generatePrompt: expect.any(String),
		});
		if (plan && "generatePrompt" in plan) {
			expect(plan.generatePrompt.toLowerCase()).toContain("misty forest");
		}
	});

	it("ignores chat that does not mention the background", () => {
		expect(
			inferBackgroundPlan("what is the weather today?", undefined),
		).toBeNull();
	});

	it("honors explicit options over text", () => {
		expect(
			inferBackgroundPlan("change my background", undefined, {
				color: "violet",
			}),
		).toMatchObject({ op: "set", mode: "shader", color: "#7c3aed" });
	});

	it("falls through an unknown explicit catalog reference for renderer-side user catalog resolution", () => {
		expect(
			inferBackgroundPlan("change my background", undefined, {
				catalog: "sunset beach",
			}),
		).toEqual({
			op: "set",
			mode: "catalog",
			catalogId: "sunset beach",
			catalogLabel: "sunset beach",
		});
	});

	it("passes a quoted catalog reference through without curated matching", () => {
		expect(
			inferBackgroundPlan('use "sunset beach" as my background', undefined),
		).toMatchObject({
			op: "set",
			mode: "catalog",
			catalogId: "sunset beach",
		});
	});

	it("does not let an unknown catalog option override explicit image or generate inputs", () => {
		expect(
			inferBackgroundPlan("change my background", undefined, {
				catalog: "sunset beach",
				imageUrl: "/api/media/generated.png",
			}),
		).toEqual({
			op: "set",
			mode: "image",
			imageUrl: "/api/media/generated.png",
		});
		expect(
			inferBackgroundPlan("change my background", undefined, {
				catalog: "sunset beach",
				prompt: "a quiet redwood grove",
			}),
		).toEqual({
			op: "set",
			generatePrompt: "a quiet redwood grove",
		});
		expect(
			inferBackgroundPlan("generate a sunset beach background", undefined, {
				catalog: "sunset beach",
			}),
		).toMatchObject({
			op: "set",
			generatePrompt: "sunset beach",
		});
	});

	it("keeps ordinary color requests ahead of user-catalog fallback", () => {
		expect(inferBackgroundPlan("make my background teal")).toMatchObject({
			op: "set",
			mode: "shader",
			colorLabel: "teal",
		});
	});
});

describe("programmable GLSL shader plan (#10694)", () => {
	it("maps a named preset to a glsl plan", () => {
		expect(
			inferBackgroundPlan("give me a cool animated lava background", undefined),
		).toEqual({
			op: "set",
			mode: "glsl",
			presetId: "lava",
			presetLabel: "lava",
		});
	});

	it("maps preset synonyms (molten → lava, ocean → waves, cosmic → nebula)", () => {
		expect(
			inferBackgroundPlan("make the background molten", undefined),
		).toMatchObject({ mode: "glsl", presetId: "lava" });
		expect(
			inferBackgroundPlan("set the background to an ocean shader", undefined),
		).toMatchObject({ mode: "glsl", presetId: "waves" });
		expect(
			inferBackgroundPlan("give me a cosmic background", undefined),
		).toMatchObject({ mode: "glsl", presetId: "nebula" });
	});

	it("a generic 'animated shader' ask with no preset falls to the default preset", () => {
		expect(
			inferBackgroundPlan("make the background an animated shader", undefined),
		).toMatchObject({ mode: "glsl", presetId: "aurora" });
	});

	it("honors an explicit preset option", () => {
		expect(
			inferBackgroundPlan("change my background", undefined, {
				preset: "plasma",
			}),
		).toEqual({
			op: "set",
			mode: "glsl",
			presetId: "plasma",
			presetLabel: "plasma",
		});
	});

	it("a resolvable color beats a planner-stuffed preset when the text never asks for a shader (#10694 run-3 finding)", () => {
		// Live trajectory: "change the app background to teal" arrived as
		// {op:"set", color:"teal", preset:"aurora"} and the old explicit-preset
		// precedence turned a plain color request into the aurora shader.
		expect(
			inferBackgroundPlan("change the app background to teal", undefined, {
				op: "set",
				color: "teal",
				preset: "aurora",
			}),
		).toMatchObject({ op: "set", mode: "shader", color: "#0891b2" });
	});

	it("an explicit preset still wins when the text asks for a shader — both directions", () => {
		// Shader noun in the text → the preset is honored even with a color.
		expect(
			inferBackgroundPlan("make the background an animated teal", undefined, {
				preset: "plasma",
				color: "teal",
			}),
		).toMatchObject({ op: "set", mode: "glsl", presetId: "plasma" });
		// Preset vocabulary in the text → same.
		expect(
			inferBackgroundPlan("give me a lava background", undefined, {
				preset: "lava",
				color: "red",
			}),
		).toMatchObject({ op: "set", mode: "glsl", presetId: "lava" });
		// No resolvable color at all → the explicit preset applies as before.
		expect(
			inferBackgroundPlan("change my background", undefined, {
				preset: "waves",
			}),
		).toMatchObject({ op: "set", mode: "glsl", presetId: "waves" });
	});

	it("maps a relative tweak to a glsl-tweak plan (uniform patch)", () => {
		expect(
			inferBackgroundPlan("make the background shader slower", undefined),
		).toMatchObject({
			op: "set",
			mode: "glsl-tweak",
			uniforms: { u_speed: 0.4 },
		});
		expect(
			inferBackgroundPlan("make the shader background brighter", undefined),
		).toMatchObject({ mode: "glsl-tweak", uniforms: { u_intensity: 1.7 } });
	});

	it("a concrete color beats a bare tweak word (red brighter → red)", () => {
		expect(
			inferBackgroundPlan("make the background red brighter", undefined),
		).toMatchObject({ op: "set", mode: "shader", color: "#dc2626" });
	});

	it("a named preset beats a bare color (fiery → lava, not red)", () => {
		expect(
			inferBackgroundPlan("make the background fiery red", undefined),
		).toMatchObject({ mode: "glsl", presetId: "lava" });
	});
});

describe("BACKGROUND action handler", () => {
	it("uses the shared background apply event contract", () => {
		expect(BACKGROUND_APPLY_EVENT).toBe(SHARED_BACKGROUND_APPLY_EVENT);
	});

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

	it("broadcasts a named shader preset and confirms", async () => {
		const { action, emitted, replies, callback } = setup();
		const result = await action.handler(
			runtime,
			message("give me an animated lava background"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([{ op: "set", mode: "glsl", presetId: "lava" }]);
		expect(result.success).toBe(true);
		expect(replies[0].toLowerCase()).toContain("lava");
	});

	it("broadcasts a uniform tweak (mode glsl, uniforms only) for a relative ask", async () => {
		const { action, emitted, replies, callback } = setup();
		await action.handler(
			runtime,
			message("make the shader background slower"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([
			{ op: "set", mode: "glsl", uniforms: { u_speed: 0.4 } },
		]);
		expect(replies[0].toLowerCase()).toContain("slower");
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

	it("does not generate from unusable attachment intent", async () => {
		const emitted: BackgroundApplyPayload[] = [];
		const generateImage = vi.fn(async () => "/api/media/generated.png");
		const action = createBackgroundAction({
			emit: async (payload) => {
				emitted.push(payload);
			},
			generateImage,
		});
		const result = await action.handler(
			runtime,
			message("set the background from this attachment", [
				{ contentType: "image" } as Media,
			]),
			undefined,
			undefined,
			vi.fn(),
		);
		expect(result.success).toBe(false);
		expect(generateImage).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);
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

	it("broadcasts redo", async () => {
		const { action, emitted, replies, callback } = setup();
		const result = await action.handler(
			runtime,
			message("redo the background"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([{ op: "redo" }]);
		expect(result.success).toBe(true);
		expect(result.values).toEqual({ op: "redo" });
		expect(replies[0].toLowerCase()).toContain("re-applied");
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

describe("BACKGROUND action — catalog name-select + upload handoff (#13538)", () => {
	function setup() {
		const emitted: BackgroundApplyPayload[] = [];
		const navigated: NavigateViewDetail[] = [];
		const replies: string[] = [];
		const action = createBackgroundAction({
			emit: async (payload) => {
				emitted.push(payload);
			},
			generateImage: async () => "/api/media/generated.png",
			navigate: async (detail) => {
				navigated.push(detail);
			},
		});
		const callback = vi.fn(async (content: { text?: string }) => {
			if (content.text) replies.push(content.text);
			return [];
		});
		return { action, emitted, navigated, replies, callback };
	}

	it("names a curated catalog entry via catalogId (no color/preset)", async () => {
		const { action, emitted, replies, callback } = setup();
		const result = await action.handler(
			runtime,
			message("use the misty-forest background"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([{ op: "set", catalogId: "misty-forest" }]);
		expect(result.success).toBe(true);
		expect(replies[0]).toContain("Misty Forest");
	});

	it("resolves a fuzzy catalog name to the canonical id", async () => {
		const { action, emitted } = setup();
		await action.handler(
			runtime,
			message("switch the wallpaper to ocean deep"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		expect(emitted).toEqual([{ op: "set", catalogId: "ocean-deep" }]);
	});

	it("passes a user-saved catalog reference through for renderer-side lookup", async () => {
		const { action, emitted, replies, callback } = setup();
		const result = await action.handler(
			runtime,
			message("use my sunset wallpaper"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([{ op: "set", catalogId: "sunset" }]);
		expect(result.success).toBe(true);
		expect(replies[0]).toContain("sunset");
	});

	it("an explicit generate wins over a same-named catalog entry", async () => {
		const { action, emitted } = setup();
		await action.handler(
			runtime,
			message("generate a misty forest background"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		// generate path emits an image (generated url), NOT a catalogId select.
		expect(emitted).toEqual([
			{ op: "set", mode: "image", imageUrl: "/api/media/generated.png" },
		]);
	});

	it("routes an upload intent to the /background view (no dead end)", async () => {
		const { action, emitted, navigated, replies, callback } = setup();
		const result = await action.handler(
			runtime,
			message("i want to upload my own background image"),
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([]);
		expect(navigated).toEqual([
			{ viewId: "background", viewPath: "/background" },
		]);
		expect(result.success).toBe(true);
		expect(replies[0]).toContain("Background view");
	});

	it("'choose a green background' applies the COLOR, not an upload handoff", async () => {
		const { action, emitted, navigated } = setup();
		await action.handler(
			runtime,
			message("choose a green background"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		expect(navigated).toEqual([]);
		expect(emitted).toEqual([{ op: "set", mode: "shader", color: "#059669" }]);
	});

	it("'pick a blue wallpaper' applies the COLOR, not an upload handoff", async () => {
		const { action, emitted, navigated } = setup();
		await action.handler(
			runtime,
			message("pick a blue wallpaper"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		expect(navigated).toEqual([]);
		expect(emitted).toEqual([{ op: "set", mode: "shader", color: "#2563eb" }]);
	});

	it("'choose from my photos' IS an upload handoff (device-file intent)", async () => {
		const { action, navigated } = setup();
		await action.handler(
			runtime,
			message("choose a background from my photos"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		expect(navigated).toEqual([
			{ viewId: "background", viewPath: "/background" },
		]);
	});

	it("a generic color word does NOT resolve to a catalog entry", async () => {
		const { action, emitted } = setup();
		// "green" is a tag on misty-forest but must stay a COLOR request.
		await action.handler(
			runtime,
			message("make the background green"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		expect(emitted).toEqual([{ op: "set", mode: "shader", color: "#059669" }]);
	});

	it("an ATTACHED image wins over a same-named catalog entry", async () => {
		const { action, emitted } = setup();
		await action.handler(
			runtime,
			message("use this misty forest background", [
				{ url: "/api/media/mine.png", contentType: "image" } as Media,
			]),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		// The attachment is applied — NOT the curated Misty Forest catalog entry.
		expect(emitted).toEqual([
			{ op: "set", mode: "image", imageUrl: "/api/media/mine.png" },
		]);
	});

	it("does NOT hijack a described-image set as an upload handoff", async () => {
		const { action, emitted, navigated } = setup();
		await action.handler(
			runtime,
			message("set the background to a picture of a forest"),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		// A described image → generate path, NOT the upload view.
		expect(navigated).toEqual([]);
		expect(emitted).toEqual([
			{ op: "set", mode: "image", imageUrl: "/api/media/generated.png" },
		]);
	});

	it("does NOT hijack an attachment-backed set as an upload handoff", async () => {
		const { action, emitted, navigated } = setup();
		await action.handler(
			runtime,
			message("set this as my background", [
				{ url: "/api/media/photo.png", contentType: "image" } as Media,
			]),
			undefined,
			undefined,
			vi.fn(async () => []),
		);
		// With a usable attachment, apply it — don't route to the upload view.
		expect(navigated).toEqual([]);
		expect(emitted).toEqual([
			{ op: "set", mode: "image", imageUrl: "/api/media/photo.png" },
		]);
	});
});
