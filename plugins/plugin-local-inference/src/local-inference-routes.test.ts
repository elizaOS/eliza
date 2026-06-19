import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function freshActiveState() {
	return {
		modelId: null as string | null,
		loadedAt: null as string | null,
		status: "idle" as "idle" | "loading" | "ready" | "error",
		loadedContextSize: null as number | null,
		loadedCacheTypeK: null as string | null,
		loadedCacheTypeV: null as string | null,
		loadedGpuLayers: null as number | null,
	};
}

function createRouteTestMocks() {
	const state = { active: freshActiveState() };
	return {
		bridgeMock: {
			getMobileDeviceBridgeStatus: vi.fn(() => ({
				enabled: false,
				connected: false,
				devices: [],
			})),
			loadMobileDeviceBridgeModel: vi.fn(),
			unloadMobileDeviceBridgeModel: vi.fn(),
		},
		aospMock: {
			buildAospLoadModelArgs: vi.fn((role: string, modelPath: string) => ({
				modelPath,
				contextSize: role === "chat" ? 4096 : 512,
				draftModelPath: `${modelPath}.draft`,
				kvCacheType: { k: "qjl1_256", v: "q4_polar" },
			})),
			activateAospLocalInferenceModel: vi.fn(
				async (args: { modelId: string }) => ({
					modelId: args.modelId,
					loadedAt: "2026-05-17T06:17:00.000Z",
					status: "ready",
					loadedContextSize: 4096,
					loadedCacheTypeK: "qjl1_256",
					loadedCacheTypeV: "q4_polar",
					loadedGpuLayers: 0,
				}),
			),
			clearAospLocalInferenceModel: vi.fn(async () => ({
				modelId: null,
				loadedAt: null,
				status: "idle",
			})),
		},
		serviceMock: {
			getActive: () => state.active,
			setActiveState: (next: ReturnType<typeof freshActiveState>) => {
				state.active = next;
			},
			setActive: vi.fn(async (_runtime: unknown, modelId: string) => {
				state.active = {
					modelId,
					loadedAt: "2026-05-17T06:17:00.000Z",
					status: "ready",
					loadedContextSize: 4096,
					loadedCacheTypeK: "qjl1_256",
					loadedCacheTypeV: "q4_polar",
					loadedGpuLayers: 0,
				};
				return state.active;
			}),
			clearActive: vi.fn(async () => {
				state.active = freshActiveState();
				return state.active;
			}),
		},
	};
}

function getRouteTestMocks(): ReturnType<typeof createRouteTestMocks> {
	const globalWithMocks = globalThis as typeof globalThis & {
		__localInferenceRoutesTestMocks?: ReturnType<typeof createRouteTestMocks>;
	};
	globalWithMocks.__localInferenceRoutesTestMocks ??= createRouteTestMocks();
	return globalWithMocks.__localInferenceRoutesTestMocks;
}

vi.mock("./services/service.ts", () => ({
	localInferenceService: {
		getActive: getRouteTestMocks().serviceMock.getActive,
		setActive: getRouteTestMocks().serviceMock.setActive,
		clearActive: getRouteTestMocks().serviceMock.clearActive,
	},
}));

vi.mock("./services/service.js", () => ({
	localInferenceService: {
		getActive: getRouteTestMocks().serviceMock.getActive,
		setActive: getRouteTestMocks().serviceMock.setActive,
		clearActive: getRouteTestMocks().serviceMock.clearActive,
	},
}));

vi.mock("@elizaos/plugin-capacitor-bridge", () => ({
	getMobileDeviceBridgeStatus:
		getRouteTestMocks().bridgeMock.getMobileDeviceBridgeStatus,
	loadMobileDeviceBridgeModel:
		getRouteTestMocks().bridgeMock.loadMobileDeviceBridgeModel,
	unloadMobileDeviceBridgeModel:
		getRouteTestMocks().bridgeMock.unloadMobileDeviceBridgeModel,
}));

vi.mock("@elizaos/plugin-aosp-local-inference", () => ({
	activateAospLocalInferenceModel:
		getRouteTestMocks().aospMock.activateAospLocalInferenceModel,
	buildAospLoadModelArgs: getRouteTestMocks().aospMock.buildAospLoadModelArgs,
	clearAospLocalInferenceModel:
		getRouteTestMocks().aospMock.clearAospLocalInferenceModel,
}));

import {
	getLocalInferenceActiveModelId,
	getLocalInferenceActiveSnapshot,
	getLocalInferenceChatStatus,
	handleLocalInferenceRoutes,
} from "./local-inference-routes.js";

const { aospMock, bridgeMock, serviceMock } = getRouteTestMocks();
const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalLocalLlama = process.env.ELIZA_LOCAL_LLAMA;
let tempStateDir: string | null = null;

function makeJsonRequest(
	method: string,
	url: string,
	body?: unknown,
): http.IncomingMessage {
	const req = new PassThrough() as http.IncomingMessage;
	req.method = method;
	req.url = url;
	req.headers = { "content-type": "application/json" };
	req.end(body === undefined ? undefined : JSON.stringify(body));
	return req;
}

function makeJsonResponse(): http.ServerResponse & {
	json: () => unknown;
} {
	let body = "";
	const res = {
		statusCode: 200,
		setHeader: vi.fn(),
		writeHead: vi.fn((statusCode: number) => {
			res.statusCode = statusCode;
			return res;
		}),
		end: vi.fn((chunk?: unknown) => {
			if (chunk !== undefined) body += String(chunk);
			return res;
		}),
		json: () => JSON.parse(body),
	} as unknown as http.ServerResponse & { json: () => unknown };
	return res;
}

function writeInstalledModel(id: string): string {
	const root = path.join(tempStateDir ?? "", "local-inference");
	const modelPath = path.join(
		root,
		"models",
		`${id}.bundle`,
		"text",
		`${id}.gguf`,
	);
	mkdirSync(path.dirname(modelPath), { recursive: true });
	writeFileSync(modelPath, "GGUF");
	writeFileSync(
		path.join(root, "registry.json"),
		JSON.stringify({
			version: 1,
			models: [
				{
					id,
					displayName: id,
					path: modelPath,
					source: "eliza-download",
					runtimeRole: "chat",
					sizeBytes: 4,
					installedAt: "2026-05-17T06:17:00.000Z",
				},
			],
		}),
	);
	return modelPath;
}

describe("local inference chat status", () => {
	beforeEach(() => {
		if (tempStateDir) {
			rmSync(tempStateDir, { recursive: true, force: true });
		}
		vi.clearAllMocks();
		tempStateDir = mkdtempSync(path.join(tmpdir(), "eliza-local-routes-"));
		process.env.ELIZA_STATE_DIR = tempStateDir;
		serviceMock.setActiveState({
			modelId: null,
			loadedAt: null,
			status: "idle",
			loadedContextSize: null,
			loadedCacheTypeK: null,
			loadedCacheTypeV: null,
			loadedGpuLayers: null,
		});
		delete process.env.ELIZA_LOCAL_LLAMA;
	});

	afterEach(() => {
		if (tempStateDir) {
			rmSync(tempStateDir, { recursive: true, force: true });
			tempStateDir = null;
		}
		if (originalStateDir === undefined) {
			delete process.env.ELIZA_STATE_DIR;
		} else {
			process.env.ELIZA_STATE_DIR = originalStateDir;
		}
		if (originalLocalLlama === undefined) {
			delete process.env.ELIZA_LOCAL_LLAMA;
		} else {
			process.env.ELIZA_LOCAL_LLAMA = originalLocalLlama;
		}
	});

	it("uses the desktop active-model service state for chat status", async () => {
		serviceMock.setActiveState({
			modelId: "eliza-1-0_8b",
			loadedAt: "2026-05-16T02:22:23.512Z",
			status: "ready",
			loadedContextSize: 131_072,
			loadedCacheTypeK: null,
			loadedCacheTypeV: null,
			loadedGpuLayers: 99,
		});

		await expect(getLocalInferenceActiveSnapshot()).resolves.toMatchObject({
			modelId: "eliza-1-0_8b",
			status: "ready",
			loadedContextSize: 131_072,
			loadedGpuLayers: 99,
		});
		expect(getLocalInferenceActiveModelId()).toBe("eliza-1-0_8b");

		const status = await getLocalInferenceChatStatus("status");
		expect(status.localInference).toMatchObject({
			intent: "status",
			status: "ready",
			modelId: "eliza-1-0_8b",
			activeModelId: "eliza-1-0_8b",
			provider: "eliza-local-inference",
		});
		expect(status.text).toContain("Model: eliza-1-0_8b.");
		expect(status.text).not.toMatch(/none is loaded|waiting to be activated/i);
	});

	it("uses the AOSP active marker when the native APK loader has the chat model open", async () => {
		const root = path.join(tempStateDir ?? "", "local-inference");
		const modelPath = path.join(
			root,
			"models",
			"eliza-1-0_8b.bundle",
			"text",
			"eliza-1-0_8b-32k.gguf",
		);
		mkdirSync(path.dirname(modelPath), { recursive: true });
		writeFileSync(modelPath, "GGUF");
		writeFileSync(
			path.join(root, "registry.json"),
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "eliza-1-0_8b",
						displayName: "eliza-1-0_8b",
						path: modelPath,
						runtimeRole: "chat",
					},
				],
			}),
		);
		writeFileSync(
			path.join(root, "aosp-active.json"),
			JSON.stringify({
				version: 1,
				status: "ready",
				role: "chat",
				provider: "eliza-aosp-llama",
				path: modelPath,
				loadedAt: "2026-05-16T02:09:05.833Z",
			}),
		);

		await expect(getLocalInferenceActiveSnapshot()).resolves.toMatchObject({
			modelId: "eliza-1-0_8b",
			status: "ready",
			loadedAt: "2026-05-16T02:09:05.833Z",
		});
	});

	it("activates through the AOSP loader instead of Capacitor when ELIZA_LOCAL_LLAMA is enabled", async () => {
		process.env.ELIZA_LOCAL_LLAMA = "1";
		writeInstalledModel("eliza-1-2b");
		const runtime = {
			getService: vi.fn(() => null),
		};
		const req = makeJsonRequest("POST", "/api/local-inference/active", {
			modelId: "eliza-1-2b",
		});
		const res = makeJsonResponse();

		await expect(
			handleLocalInferenceRoutes(req, res, { current: runtime as never }),
		).resolves.toBe(true);

		expect(serviceMock.setActive).not.toHaveBeenCalled();
		expect(aospMock.activateAospLocalInferenceModel).toHaveBeenCalledWith(
			expect.objectContaining({
				modelId: "eliza-1-2b",
				modelPath: expect.stringContaining("eliza-1-2b.gguf"),
				loadArgs: expect.objectContaining({
					modelPath: expect.stringContaining("eliza-1-2b.gguf"),
				}),
			}),
		);
		expect(bridgeMock.loadMobileDeviceBridgeModel).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			modelId: "eliza-1-2b",
			status: "ready",
			loadedCacheTypeK: "qjl1_256",
			loadedCacheTypeV: "q4_polar",
		});
	});
});
