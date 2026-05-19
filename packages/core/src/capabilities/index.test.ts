import { describe, expect, it } from "vitest";
import {
	CapabilityError,
	RuntimeBrokerCapabilityRouter,
	UnavailableCapabilityRouter,
} from "./index";

describe("capability router", () => {
	it("returns structured unavailable errors from fallback implementation", async () => {
		const router = new UnavailableCapabilityRouter("server");

		await expect(
			router.fs.readText({ path: "/tmp/file.txt" }),
		).rejects.toMatchObject({
			code: "CAPABILITY_UNAVAILABLE",
			capability: "fs",
			method: "fs.readText",
		});

		await expect(router.availability()).resolves.toMatchObject({
			environment: "server",
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
				plugin: false,
			},
		});
	});

	it("routes desktop file reads through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					path: "/tmp/file.txt",
					text: "hello",
					size: 5,
					truncated: false,
				};
			},
		});

		await expect(
			router.fs.readText({ path: "/tmp/file.txt", maxBytes: 32 }),
		).resolves.toEqual({
			path: "/tmp/file.txt",
			text: "hello",
			size: 5,
			truncated: false,
		});
		expect(calls).toEqual([
			{
				method: "fs.readText",
				params: {
					path: "/tmp/file.txt",
					maxBytes: 32,
				},
			},
		]);
	});

	it("routes desktop directory listings through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					root: { id: "workspace", path: "/repo" },
					path: "/repo/src",
					entries: [
						{
							path: "/repo/src/index.ts",
							name: "index.ts",
							kind: "file",
							size: 42,
							modifiedAt: "2026-05-17T00:00:00.000Z",
							isText: true,
						},
					],
					truncated: false,
					totalAfterIgnore: 1,
				};
			},
		});

		await expect(
			router.fs.list({
				path: "/repo/src",
				limit: 100,
				includeHidden: true,
				ignore: ["*.log"],
			}),
		).resolves.toEqual({
			root: { id: "workspace", path: "/repo" },
			path: "/repo/src",
			entries: [
				{
					path: "/repo/src/index.ts",
					name: "index.ts",
					kind: "file",
					size: 42,
					modifiedAt: "2026-05-17T00:00:00.000Z",
					isText: true,
				},
			],
			truncated: false,
			totalAfterIgnore: 1,
		});
		expect(calls).toEqual([
			{
				method: "fs.list",
				params: {
					path: "/repo/src",
					limit: 100,
					includeHidden: true,
					ignore: ["*.log"],
				},
			},
		]);
	});

	it("routes desktop file writes through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					path: "/tmp/file.txt",
					bytesWritten: 5,
				};
			},
		});

		await expect(
			router.fs.writeText({
				path: "/tmp/file.txt",
				text: "hello",
				createDirectories: true,
				overwrite: true,
			}),
		).resolves.toEqual({
			path: "/tmp/file.txt",
			bytesWritten: 5,
		});
		expect(calls).toEqual([
			{
				method: "fs.writeText",
				params: {
					path: "/tmp/file.txt",
					text: "hello",
					createDirectories: true,
					overwrite: true,
				},
			},
		]);
	});

	it("wraps broker failures as capability request failures", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => {
				throw new Error("broker offline");
			},
		});

		await expect(router.model.status()).rejects.toMatchObject({
			code: "CAPABILITY_REQUEST_FAILED",
			capability: "model",
			method: "model.status",
			message: "broker offline",
		});
	});

	it("routes desktop Git command execution through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				return {
					operation: {
						id: "git-op-1",
						name: "git.command.run",
						cwd: "/repo",
						command: ["worktree", "list"],
						status: "completed",
						stdout: "/repo\n",
						stderr: "",
						exitCode: 0,
						signal: null,
						startedAt: "2026-05-17T00:00:00.000Z",
						completedAt: "2026-05-17T00:00:00.001Z",
					},
				};
			},
		});

		await expect(
			router.git.commandRun({
				root: "/repo",
				args: ["worktree", "list"],
			}),
		).resolves.toEqual({
			operation: {
				id: "git-op-1",
				name: "git.command.run",
				cwd: "/repo",
				command: ["worktree", "list"],
				status: "completed",
				stdout: "/repo\n",
				stderr: "",
				exitCode: 0,
				signal: null,
				startedAt: "2026-05-17T00:00:00.000Z",
				completedAt: "2026-05-17T00:00:00.001Z",
			},
		});
		expect(calls).toEqual([
			{
				method: "git.command.run",
				params: {
					cwd: "/repo",
					args: ["worktree", "list"],
				},
			},
		]);
	});

	it("preserves capability errors from the broker", async () => {
		const expected = new CapabilityError({
			code: "CAPABILITY_UNAVAILABLE",
			message: "not available",
			capability: "git",
			method: "git.status",
		});
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => {
				throw expected;
			},
		});

		await expect(router.git.status({ root: "/repo" })).rejects.toBe(expected);
	});

	it("routes remote plugin module manifests and invocation through the runtime broker", async () => {
		const calls: Array<{ method: string; params?: object }> = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method, params) => {
				calls.push({ method, params });
				if (method === "plugin.modules.list") {
					return {
						modules: [
							{
								id: "remote-weather",
								name: "@remote/weather",
								version: "1.0.0",
								actions: [
									{
										name: "WEATHER_LOOKUP",
										description: "Look up weather remotely.",
										similes: ["FORECAST"],
									},
								],
								providers: [{ name: "WEATHER_CONTEXT", dynamic: true }],
								evaluators: [
									{
										name: "WEATHER_MEMORY",
										description: "Evaluate weather memory.",
										prompt: "Evaluate whether to remember this weather.",
										schema: { type: "object" },
										hasPrepare: true,
										hasProcessor: true,
									},
								],
								events: [{ eventName: "WEATHER_EVENT" }],
								models: [{ modelType: "WEATHER_TEXT", priority: 10 }],
								widgets: [
									{
										id: "weather.widget",
										slot: "chat-sidebar",
										label: "Weather Widget",
									},
								],
								app: {
									displayName: "Weather",
									category: "tool",
									launchType: "url",
									launchUrl: "https://weather.example",
									viewer: {
										url: "https://weather.example/viewer",
										embedParams: { city: "sf" },
									},
									session: {
										mode: "viewer",
										features: ["commands"],
									},
									navTabs: [
										{
											id: "weather.tab",
											label: "Weather",
											path: "/weather",
										},
									],
								},
								appBridge: {
									hooks: ["prepareLaunch"],
								},
								routes: [
									{
										method: "GET",
										path: "/weather/:city",
										public: true,
									},
								],
								views: [
									{
										id: "weather-panel",
										label: "Weather",
										bundlePath: "/assets/weather.js",
									},
								],
							},
						],
					};
				}
				if (method === "plugin.evaluator.shouldRun") {
					return { shouldRun: false };
				}
				if (method === "plugin.event.handle") {
					return { handled: true };
				}
				if (method === "plugin.model.invoke") {
					return { result: "remote model text" };
				}
				if (method === "plugin.appBridge.call") {
					return { result: { launchUrl: "https://weather.example/prepared" } };
				}
				return {
					text: "Weather is clear.",
					actions: ["WEATHER_LOOKUP"],
					data: { degrees: 72 },
				};
			},
		});

		await expect(router.plugin.listModules()).resolves.toEqual({
			modules: [
				{
					id: "remote-weather",
					name: "@remote/weather",
					version: "1.0.0",
					actions: [
						{
							name: "WEATHER_LOOKUP",
							description: "Look up weather remotely.",
							similes: ["FORECAST"],
						},
					],
					providers: [{ name: "WEATHER_CONTEXT", dynamic: true }],
					evaluators: [
						{
							name: "WEATHER_MEMORY",
							description: "Evaluate weather memory.",
							prompt: "Evaluate whether to remember this weather.",
							schema: { type: "object" },
							hasPrepare: true,
							hasProcessor: true,
						},
					],
					events: [{ eventName: "WEATHER_EVENT" }],
					models: [{ modelType: "WEATHER_TEXT", priority: 10 }],
					widgets: [
						{
							id: "weather.widget",
							slot: "chat-sidebar",
							label: "Weather Widget",
						},
					],
					app: {
						displayName: "Weather",
						category: "tool",
						launchType: "url",
						launchUrl: "https://weather.example",
						viewer: {
							url: "https://weather.example/viewer",
							embedParams: { city: "sf" },
						},
						session: {
							mode: "viewer",
							features: ["commands"],
						},
						navTabs: [
							{
								id: "weather.tab",
								label: "Weather",
								path: "/weather",
							},
						],
					},
					appBridge: {
						hooks: ["prepareLaunch"],
					},
					routes: [{ method: "GET", path: "/weather/:city", public: true }],
					views: [
						{
							id: "weather-panel",
							label: "Weather",
							bundlePath: "/assets/weather.js",
						},
					],
				},
			],
		});
		await expect(
			router.plugin.invokeAction({
				moduleId: "remote-weather",
				action: "WEATHER_LOOKUP",
				content: { text: "weather in sf" },
			}),
		).resolves.toEqual({
			text: "Weather is clear.",
			actions: ["WEATHER_LOOKUP"],
			data: { degrees: 72 },
		});
		await expect(
			router.plugin.shouldRunEvaluator({
				moduleId: "remote-weather",
				evaluator: "WEATHER_MEMORY",
				message: { content: { text: "weather" } },
			}),
		).resolves.toEqual({ shouldRun: false });
		await expect(
			router.plugin.handleEvent({
				moduleId: "remote-weather",
				eventName: "WEATHER_EVENT",
				payload: { status: "clear" },
			}),
		).resolves.toEqual({ handled: true });
		await expect(
			router.plugin.invokeModel({
				moduleId: "remote-weather",
				modelType: "WEATHER_TEXT",
				params: { prompt: "forecast" },
			}),
		).resolves.toEqual({ result: "remote model text" });
		await expect(
			router.plugin.callAppBridge({
				moduleId: "remote-weather",
				hook: "prepareLaunch",
				context: { appName: "@remote/weather" },
			}),
		).resolves.toEqual({
			result: { launchUrl: "https://weather.example/prepared" },
		});
		expect(calls).toEqual([
			{ method: "plugin.modules.list", params: {} },
			{
				method: "plugin.action.invoke",
				params: {
					moduleId: "remote-weather",
					action: "WEATHER_LOOKUP",
					content: { text: "weather in sf" },
				},
			},
			{
				method: "plugin.evaluator.shouldRun",
				params: {
					moduleId: "remote-weather",
					evaluator: "WEATHER_MEMORY",
					message: { content: { text: "weather" } },
				},
			},
			{
				method: "plugin.event.handle",
				params: {
					moduleId: "remote-weather",
					eventName: "WEATHER_EVENT",
					payload: { status: "clear" },
				},
			},
			{
				method: "plugin.model.invoke",
				params: {
					moduleId: "remote-weather",
					modelType: "WEATHER_TEXT",
					params: { prompt: "forecast" },
				},
			},
			{
				method: "plugin.appBridge.call",
				params: {
					moduleId: "remote-weather",
					hook: "prepareLaunch",
					context: { appName: "@remote/weather" },
				},
			},
		]);
	});

	it("rejects remote plugin manifests with empty module identifiers", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [{ id: " ", name: "@remote/weather" }],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules",
			message: "id must be a non-empty string.",
		});
	});

	it("rejects remote plugin manifests with invalid action entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						actions: [{ name: "WEATHER_LOOKUP", description: "" }],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.actions",
			message: "description must be a non-empty string.",
		});
	});

	it("rejects remote plugin manifests with invalid provider entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						providers: [{ name: " " }],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.providers",
			message: "name must be a non-empty string.",
		});
	});

	it("rejects remote plugin manifests with invalid evaluator entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						evaluators: [
							{
								name: "WEATHER_MEMORY",
								description: "Evaluate weather memory.",
								prompt: "Evaluate weather memory.",
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.evaluators",
			message: "schema must be an object.",
		});
	});

	it("rejects remote plugin manifests with invalid event entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						events: [{ eventName: "" }],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.events",
			message: "eventName must be a non-empty string.",
		});
	});

	it("rejects remote plugin manifests with invalid model entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						models: [{ modelType: "" }],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.models",
			message: "modelType must be a non-empty string.",
		});
	});

	it("rejects remote plugin manifests with invalid widget entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						widgets: [
							{ id: "weather.widget", slot: "invalid", label: "Weather" },
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.widgets",
			message: "slot must be a valid plugin widget slot.",
		});
	});

	it("rejects remote plugin manifests with invalid app entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						app: {
							viewer: { url: "" },
						},
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.app.viewer",
			message: "url must be a non-empty string.",
		});
	});

	it("rejects remote plugin manifests with invalid app bridge entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						appBridge: {
							hooks: ["invalidHook"],
						},
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.appBridge",
			message: "hooks must be valid plugin app bridge hooks.",
		});
	});

	it("rejects remote plugin manifests with invalid route entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						routes: [{ method: "CONNECT", path: "/weather" }],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.routes",
			message: "method must be a valid plugin route method.",
		});
	});

	it("rejects remote plugin manifests with invalid view entries", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						views: [
							{
								id: "weather-panel",
								label: "Weather",
								viewType: "dashboard",
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.views",
			message: "viewType must be gui or tui when present.",
		});
	});
});
