import { describe, expect, it, vi } from "vitest";
import {
	createHomescreenAction,
	type HomescreenEventPayload,
	inferHomescreenMode,
} from "./homescreen.js";
import {
	buildHomescreenPrompt,
	extractSceneJson,
} from "./homescreen-prompt.js";

const coreMock = vi.hoisted(() => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	ModelType: { TEXT_LARGE: "TEXT_LARGE" },
	resolveServerOnlyPort: vi.fn(() => 3456),
}));
vi.mock("@elizaos/core", () => coreMock);

function message(text: string) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		agentId: "agent-1",
		content: { text },
	};
}

const VALID_SCENE = JSON.stringify({
	name: "Black",
	background: { kind: "preset", preset: "fresnel-crystal-ball" },
	theme: { accent: [1, 0.345, 0], background: 0 },
});

function setup(modelOutput = VALID_SCENE) {
	const emitted: HomescreenEventPayload[] = [];
	const emit = vi.fn(async (p: HomescreenEventPayload) => {
		emitted.push(p);
	});
	const source = { getCurrentSceneJson: vi.fn(async () => VALID_SCENE) };
	const action = createHomescreenAction({ emit, source });
	const runtime = {
		agentId: "agent-1",
		useModel: vi.fn(async () => modelOutput),
	} as never;
	const callback = vi.fn(async () => {});
	return { action, runtime, callback, emitted, emit, source };
}

describe("inferHomescreenMode", () => {
	it.each([
		["undo that", "undo"],
		["redo", "redo"],
		["reset the homescreen to default", "reset"],
		["duplicate this scene", "duplicate"],
		["delete this scene", "delete"],
		["save this homescreen", "save"],
		["create a new homescreen that looks like deep space", "create"],
		["make the background black", "edit"],
		["give me a sci-fi jarvis UI", "edit"],
	])("maps %j -> %s", (text, expected) => {
		expect(inferHomescreenMode(text)).toBe(expected);
	});

	it("returns null for unrelated requests", () => {
		expect(inferHomescreenMode("what's the weather today")).toBeNull();
	});

	it("honors an explicit op option", () => {
		expect(inferHomescreenMode("anything", { op: "reset" })).toBe("reset");
	});
});

describe("HOMESCREEN validate", () => {
	it("accepts a homescreen edit request", async () => {
		const { action, runtime } = setup();
		expect(
			await action.validate?.(
				runtime,
				message("make the background black") as never,
			),
		).toBe(true);
	});

	it("rejects an unrelated request", async () => {
		const { action, runtime } = setup();
		expect(
			await action.validate?.(runtime, message("book me a flight") as never),
		).toBe(false);
	});
});

describe("HOMESCREEN handler — edit/create", () => {
	it("forwards the model's scene JSON to the client verbatim", async () => {
		const { action, runtime, callback, emitted } = setup();
		const result = await action.handler?.(
			runtime,
			message("make the background black") as never,
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(true);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.op).toBe("edit");
		expect(emitted[0]?.sceneJson).toBe(VALID_SCENE);
		expect(runtime.useModel).toHaveBeenCalledOnce();
	});

	it("passes the current scene to the prompt on edit", async () => {
		const { action, runtime, callback, source } = setup();
		await action.handler?.(
			runtime,
			message("make the background blue") as never,
			undefined,
			undefined,
			callback,
		);
		expect(source.getCurrentSceneJson).toHaveBeenCalled();
		const prompt = (runtime.useModel as ReturnType<typeof vi.fn>).mock
			.calls[0][1].prompt as string;
		expect(prompt).toContain("CURRENT SCENE");
		expect(prompt).toContain("make the background blue");
	});

	it("extracts a fenced JSON object from a chatty model reply", async () => {
		const chatty = `Sure! Here you go:\n\`\`\`json\n${VALID_SCENE}\n\`\`\``;
		const { action, runtime, callback, emitted } = setup(chatty);
		const result = await action.handler?.(
			runtime,
			message("make the background black") as never,
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(true);
		expect(emitted[0]?.sceneJson).toBe(VALID_SCENE);
	});

	it("fails softly when the model returns no JSON", async () => {
		const { action, runtime, callback, emitted } = setup("I cannot do that.");
		const result = await action.handler?.(
			runtime,
			message("make the background black") as never,
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(false);
		expect(emitted).toHaveLength(0);
	});
});

describe("HOMESCREEN handler — history ops", () => {
	it("emits an undo op without calling the model", async () => {
		const { action, runtime, callback, emitted } = setup();
		const result = await action.handler?.(
			runtime,
			message("undo that") as never,
			undefined,
			undefined,
			callback,
		);
		expect(result?.success).toBe(true);
		expect(emitted).toEqual([{ op: "undo" }]);
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("emits a reset op", async () => {
		const { action, runtime, callback, emitted } = setup();
		await action.handler?.(
			runtime,
			message("reset the homescreen to default") as never,
			undefined,
			undefined,
			callback,
		);
		expect(emitted).toEqual([{ op: "reset" }]);
	});
});

describe("prompt helpers", () => {
	it("buildHomescreenPrompt documents the input contract", () => {
		const prompt = buildHomescreenPrompt({
			mode: "edit",
			request: "make it black",
			currentSceneJson: VALID_SCENE,
		});
		expect(prompt).toContain("inputs.energy");
		expect(prompt).toContain("inputs.phase");
		expect(prompt).toContain("SceneInstance");
		expect(prompt).toContain("optimize(tier)");
	});

	it("extractSceneJson handles balanced nested braces", () => {
		const nested = '{"a":{"b":{"c":1}},"d":2}';
		expect(extractSceneJson(`noise ${nested} trailing`)).toBe(nested);
	});

	it("extractSceneJson ignores braces inside strings", () => {
		const tricky = '{"code":"return {x:1};"}';
		expect(extractSceneJson(tricky)).toBe(tricky);
	});

	it("extractSceneJson returns null when no object is present", () => {
		expect(extractSceneJson("no json here")).toBeNull();
	});
});
