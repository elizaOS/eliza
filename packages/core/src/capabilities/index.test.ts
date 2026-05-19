import { describe, expect, it } from "vitest";
import {
	CAPABILITY_ROUTER_PROTOCOL_FIXTURE,
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

	it("keeps the canonical capability-router protocol fixture decoder-valid", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				if (method === "plugin.modules.list") {
					return { modules: [CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module] };
				}
				if (method === "plugin.action.invoke") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action;
				}
				if (method === "plugin.provider.get") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider;
				}
				if (method === "plugin.route.call") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route;
				}
				if (method === "plugin.asset.get") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset;
				}
				if (method === "plugin.model.invoke") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model;
				}
				if (method === "plugin.lifecycle.call") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle;
				}
				if (method === "plugin.event.handle") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event;
				}
				if (method === "plugin.service.call") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service;
				}
				if (method === "plugin.appBridge.call") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge;
				}
				if (method === "plugin.evaluator.shouldRun") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun;
				}
				if (method === "plugin.evaluator.prepare") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare;
				}
				if (method === "plugin.evaluator.prompt") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt;
				}
				if (method === "plugin.evaluator.process") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess;
				}
				if (method === "plugin.responseHandlerEvaluator.shouldRun") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
						.responseHandlerEvaluatorShouldRun;
				}
				if (method === "plugin.responseHandlerEvaluator.evaluate") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
						.responseHandlerEvaluatorEvaluate;
				}
				if (method === "plugin.responseHandlerFieldEvaluator.shouldRun") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
						.responseHandlerFieldEvaluatorShouldRun;
				}
				if (method === "plugin.responseHandlerFieldEvaluator.parse") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
						.responseHandlerFieldEvaluatorParse;
				}
				if (method === "plugin.responseHandlerFieldEvaluator.handle") {
					return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
						.responseHandlerFieldEvaluatorHandle;
				}
				throw new Error(`unexpected method ${method}`);
			},
		});

		await expect(router.plugin.listModules()).resolves.toEqual({
			modules: [CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module],
		});
		await expect(
			router.plugin.invokeAction({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				action: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.actions[0].name,
				content: { text: "fixture" },
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action);
		await expect(
			router.plugin.getProvider({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				provider: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.providers[0].name,
				state: {},
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider);
		await expect(
			router.plugin.callRoute({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				method: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.routes[0].method,
				path: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.routes[0].path,
				headers: {},
				body: { fixture: true },
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route);
		await expect(
			router.plugin.getAsset({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				path:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.views[0].bundlePath ?? "",
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset);
		await expect(
			router.plugin.invokeModel({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				modelType:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.models[0].modelType,
				params: { prompt: "fixture" },
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model);
		await expect(
			router.plugin.callLifecycle({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				hook: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.lifecycle.hooks[0],
				context: { fixture: true },
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle);
		await expect(
			router.plugin.handleEvent({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				eventName:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.events[0].eventName,
				payload: { fixture: true },
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event);
		await expect(
			router.plugin.callService({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				serviceType:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.services[0].serviceType,
				method:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.services[0].methods[0],
				args: [{ fixture: true }],
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service);
		await expect(
			router.plugin.callAppBridge({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				hook: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.appBridge.hooks[0],
				context: { fixture: true },
			}),
		).resolves.toEqual(CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge);
		await expect(
			router.plugin.shouldRunEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				evaluator: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.evaluators[0].name,
				message: { text: "fixture" },
				state: {},
				options: {},
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun,
		);
		await expect(
			router.plugin.prepareEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				evaluator: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.evaluators[0].name,
				message: { text: "fixture" },
				state: {},
				options: {},
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare,
		);
		await expect(
			router.plugin.promptEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				evaluator: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.evaluators[0].name,
				message: { text: "fixture" },
				state: {},
				options: {},
				prepared:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare.prepared,
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt,
		);
		await expect(
			router.plugin.processEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				evaluator: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.evaluators[0].name,
				message: { text: "fixture" },
				state: {},
				options: {},
				prepared:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare.prepared,
				output: { text: "fixture output" },
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess,
		);
		await expect(
			router.plugin.shouldRunResponseHandlerEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				evaluator:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.responseHandlerEvaluators[0]
						.name,
				context: { fixture: true },
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
				.responseHandlerEvaluatorShouldRun,
		);
		await expect(
			router.plugin.evaluateResponseHandlerEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				evaluator:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.responseHandlerEvaluators[0]
						.name,
				context: { fixture: true },
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
				.responseHandlerEvaluatorEvaluate,
		);
		await expect(
			router.plugin.shouldRunResponseHandlerFieldEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				field:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module
						.responseHandlerFieldEvaluators[0].name,
				context: { fixture: true },
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
				.responseHandlerFieldEvaluatorShouldRun,
		);
		await expect(
			router.plugin.parseResponseHandlerFieldEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				field:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module
						.responseHandlerFieldEvaluators[0].name,
				context: { fixture: true },
				value: { raw: true },
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
				.responseHandlerFieldEvaluatorParse,
		);
		await expect(
			router.plugin.handleResponseHandlerFieldEvaluator({
				moduleId: CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module.id,
				field:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module
						.responseHandlerFieldEvaluators[0].name,
				context: { fixture: true },
				value: { raw: true },
				parsed:
					CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
						.responseHandlerFieldEvaluatorParse.value,
			}),
		).resolves.toEqual(
			CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results
				.responseHandlerFieldEvaluatorHandle,
		);
		expect(calls).toEqual([
			"plugin.modules.list",
			"plugin.action.invoke",
			"plugin.provider.get",
			"plugin.route.call",
			"plugin.asset.get",
			"plugin.model.invoke",
			"plugin.lifecycle.call",
			"plugin.event.handle",
			"plugin.service.call",
			"plugin.appBridge.call",
			"plugin.evaluator.shouldRun",
			"plugin.evaluator.prepare",
			"plugin.evaluator.prompt",
			"plugin.evaluator.process",
			"plugin.responseHandlerEvaluator.shouldRun",
			"plugin.responseHandlerEvaluator.evaluate",
			"plugin.responseHandlerFieldEvaluator.shouldRun",
			"plugin.responseHandlerFieldEvaluator.parse",
			"plugin.responseHandlerFieldEvaluator.handle",
		]);
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
								schema: {
									weather_records: {
										id: "uuid",
										city: "text",
									},
								},
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
								services: [
									{
										serviceType: "weather_service",
										capabilityDescription: "Remote weather service.",
										methods: ["lookup"],
										config: { unit: "fahrenheit" },
									},
								],
								componentTypes: [
									{
										name: "weather.component",
										schema: {
											type: "object",
											properties: {
												city: { type: "string" },
												unit: {
													type: "string",
													enumValues: ["fahrenheit", "celsius"],
												},
											},
											required: ["city"],
										},
									},
								],
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
				if (method === "plugin.service.call") {
					return { result: { ok: true, service: "weather" } };
				}
				if (method === "plugin.appBridge.call") {
					return { result: { launchUrl: "https://weather.example/prepared" } };
				}
				if (method === "plugin.route.call") {
					return {
						status: 203,
						headers: { "x-weather": "clear" },
						body: { ok: true },
					};
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
					schema: {
						weather_records: {
							id: "uuid",
							city: "text",
						},
					},
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
					services: [
						{
							serviceType: "weather_service",
							capabilityDescription: "Remote weather service.",
							methods: ["lookup"],
							config: { unit: "fahrenheit" },
						},
					],
					componentTypes: [
						{
							name: "weather.component",
							schema: {
								type: "object",
								properties: {
									city: { type: "string" },
									unit: {
										type: "string",
										enumValues: ["fahrenheit", "celsius"],
									},
								},
								required: ["city"],
							},
						},
					],
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
			router.plugin.callService({
				moduleId: "remote-weather",
				serviceType: "weather_service",
				method: "lookup",
				args: [{ city: "sf" }],
			}),
		).resolves.toEqual({ result: { ok: true, service: "weather" } });
		await expect(
			router.plugin.callAppBridge({
				moduleId: "remote-weather",
				hook: "prepareLaunch",
				context: { appName: "@remote/weather" },
			}),
		).resolves.toEqual({
			result: { launchUrl: "https://weather.example/prepared" },
		});
		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
				headers: { accept: "application/json" },
			}),
		).resolves.toEqual({
			status: 203,
			headers: { "x-weather": "clear" },
			body: { ok: true },
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
				method: "plugin.service.call",
				params: {
					moduleId: "remote-weather",
					serviceType: "weather_service",
					method: "lookup",
					args: [{ city: "sf" }],
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
			{
				method: "plugin.route.call",
				params: {
					moduleId: "remote-weather",
					method: "GET",
					path: "/weather/sf",
					headers: { accept: "application/json" },
				},
			},
		]);
	});

	it("routes remote plugin asset reads through the runtime broker", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				path: "/assets/weather.js",
				contentType: "text/javascript",
				bodyBase64: Buffer.from("export const weather = true;").toString(
					"base64",
				),
				integrity: "sha256-weather",
			}),
		});

		await expect(
			router.plugin.getAsset({
				moduleId: "remote-weather",
				path: "/assets/weather.js",
			}),
		).resolves.toEqual({
			path: "/assets/weather.js",
			contentType: "text/javascript",
			bodyBase64: "ZXhwb3J0IGNvbnN0IHdlYXRoZXIgPSB0cnVlOw==",
			integrity: "sha256-weather",
		});
	});

	it("rejects remote plugin assets with unsafe returned paths", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				path: "../secret.js",
				contentType: "text/javascript",
				bodyBase64: Buffer.from("export default {};").toString("base64"),
			}),
		});

		await expect(
			router.plugin.getAsset({
				moduleId: "remote-weather",
				path: "/assets/weather.js",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.asset.get",
			message:
				"path must not contain empty, current-directory, or parent-directory segments.",
		});
	});

	it("rejects remote plugin assets with unsafe content types", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				path: "/assets/weather.js",
				contentType: "text/javascript\r\nx-injected: yes",
				bodyBase64: Buffer.from("export default {};").toString("base64"),
			}),
		});

		await expect(
			router.plugin.getAsset({
				moduleId: "remote-weather",
				path: "/assets/weather.js",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.asset.get",
			message: "contentType must not contain control characters.",
		});
	});

	it("rejects remote plugin assets with invalid base64 bodies", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				path: "/assets/weather.js",
				contentType: "text/javascript",
				bodyBase64: "not base64!",
			}),
		});

		await expect(
			router.plugin.getAsset({
				moduleId: "remote-weather",
				path: "/assets/weather.js",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.asset.get",
			message: "bodyBase64 must be valid base64.",
		});
	});

	it("rejects remote plugin assets with unsafe integrity metadata", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				path: "/assets/weather.js",
				contentType: "text/javascript",
				bodyBase64: Buffer.from("export default {};").toString("base64"),
				integrity: "sha256-ok\r\nx-injected: yes",
			}),
		});

		await expect(
			router.plugin.getAsset({
				moduleId: "remote-weather",
				path: "/assets/weather.js",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.asset.get",
			message: "integrity must not contain control characters.",
		});
	});

	it("rejects outbound remote plugin route calls with invalid methods", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return { status: 200 };
			},
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "STATIC",
				path: "/weather/sf",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "method must be a valid plugin route method.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin route calls with unsafe paths", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return { status: 200 };
			},
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/../secret",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message:
				"path must not contain empty, current-directory, or parent-directory segments.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin route calls with unsafe headers", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return { status: 200 };
			},
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
				headers: { "x-weather": "clear\r\nx-injected: yes" },
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "headers must not contain control characters.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin route calls with unsafe query keys", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return { status: 200 };
			},
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
				query: { "city\r\nx-injected": "sf" },
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "query must contain valid query keys.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin route calls with unsafe query values", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return { status: 200 };
			},
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
				query: { city: ["sf", "oakland\r\nx-injected: yes"] },
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "query must contain valid query values.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin calls with unsafe endpoint ids", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {};
			},
		});

		await expect(
			router.plugin.invokeAction({
				endpointId: "primary\r\nsecondary",
				moduleId: "remote-weather",
				action: "WEATHER_LOOKUP",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "capability.endpoint",
			message: "endpointId must not contain control characters.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin asset requests with unsafe paths", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {
					path: "/assets/weather.js",
					contentType: "text/javascript",
					bodyBase64: "",
				};
			},
		});

		await expect(
			router.plugin.getAsset({
				moduleId: "remote-weather",
				path: "https://weather.example/assets/weather.js",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.asset.get",
			message:
				"path must be an asset path without query, hash, URL scheme, or backslash.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin action calls with empty module ids", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {};
			},
		});

		await expect(
			router.plugin.invokeAction({
				moduleId: " ",
				action: "WEATHER_LOOKUP",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.action.invoke",
			message: "moduleId must be a non-empty string.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin action calls with ambiguous module ids", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {};
			},
		});

		await expect(
			router.plugin.invokeAction({
				moduleId: "remote:weather",
				action: "WEATHER_LOOKUP",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.action.invoke",
			message:
				"moduleId must use letters, numbers, dots, underscores, or hyphens.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin provider calls with empty names", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {};
			},
		});

		await expect(
			router.plugin.getProvider({
				moduleId: "remote-weather",
				provider: " ",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.provider.get",
			message: "provider must be a non-empty string.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin service calls with invalid method names", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {};
			},
		});

		await expect(
			router.plugin.callService({
				moduleId: "remote-weather",
				serviceType: "weather_service",
				method: "callRemote",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.service.call",
			message: "methods must not include reserved local service method names.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects outbound remote plugin app bridge calls with invalid hooks", async () => {
		const calls: string[] = [];
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async (method) => {
				calls.push(method);
				return {};
			},
		});

		await expect(
			router.plugin.callAppBridge({
				moduleId: "remote-weather",
				hook: "launchEverything" as never,
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.appBridge.call",
			message: "hook must be a valid plugin app bridge hook.",
		});
		expect(calls).toEqual([]);
	});

	it("rejects remote plugin route responses with invalid status codes", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				status: 99,
				body: { ok: false },
			}),
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "status must be an integer HTTP status code.",
		});
	});

	it("rejects remote plugin route responses with invalid header names", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				status: 200,
				headers: { "x-weather\r\nx-injected": "clear" },
			}),
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "headers must contain valid header names.",
		});
	});

	it("rejects remote plugin route responses with unsafe header values", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				status: 200,
				headers: { "x-weather": "clear\r\nx-injected: yes" },
			}),
		});

		await expect(
			router.plugin.callRoute({
				moduleId: "remote-weather",
				method: "GET",
				path: "/weather/sf",
			}),
		).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.route.call",
			message: "headers must not contain control characters.",
		});
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

	it("rejects remote plugin manifests with ambiguous module identifiers", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [{ id: "remote:weather", name: "@remote/weather" }],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules",
			message: "id must use letters, numbers, dots, underscores, or hyphens.",
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

	it("rejects remote plugin service methods that would overwrite local service internals", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						services: [
							{
								serviceType: "weather_service",
								methods: ["lookup", "callRemote"],
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.services",
			message: "methods must not include reserved local service method names.",
		});
	});

	it("rejects remote plugin service methods that are not JavaScript identifiers", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						services: [
							{
								serviceType: "weather_service",
								methods: ["lookup-user"],
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.services",
			message: "methods must contain valid JavaScript method identifiers.",
		});
	});

	it("rejects remote plugin service methods with duplicate names", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						services: [
							{
								serviceType: "weather_service",
								methods: ["lookup", "lookup"],
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.services",
			message: "methods must not contain duplicate method names.",
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

	it("rejects remote plugin app viewer URLs that are unsafe for browser embedding", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						app: {
							viewer: { url: "javascript:alert(1)" },
						},
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.app.viewer",
			message:
				"url must be an absolute http(s) URL without embedded credentials.",
		});
	});

	it("rejects remote plugin app launch URLs that are unsafe for browser launch", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						app: {
							launchUrl: "https://user:pass@weather.example",
						},
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.app",
			message:
				"launchUrl must be an absolute http(s) URL without embedded credentials.",
		});
	});

	it("rejects remote plugin app nav paths that are unsafe for app navigation", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						app: {
							navTabs: [
								{
									id: "weather",
									label: "Weather",
									path: "https://weather.example/app",
								},
							],
						},
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.app.navTabs",
			message:
				"path must be an absolute app path without URL scheme, query, hash, or backslash.",
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

	it("rejects remote plugin routes with unsafe route paths", async () => {
		const router = new RuntimeBrokerCapabilityRouter({
			invokeRuntime: async () => ({
				modules: [
					{
						id: "remote-weather",
						name: "@remote/weather",
						routes: [{ method: "GET", path: "/weather/../secret" }],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.routes",
			message:
				"path must not contain empty, current-directory, or parent-directory segments.",
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

	it("rejects remote plugin views with unsafe bundle paths", async () => {
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
								bundlePath: "../secrets.js",
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.views",
			message:
				"bundlePath must not contain empty, current-directory, or parent-directory segments.",
		});
	});

	it("rejects remote plugin views with unsafe bundle URLs", async () => {
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
								bundleUrl: "javascript:alert(1)",
							},
						],
					},
				],
			}),
		});

		await expect(router.plugin.listModules()).rejects.toMatchObject({
			code: "CAPABILITY_DECODE_FAILED",
			method: "plugin.modules.list.modules.views",
			message:
				"bundleUrl must be an absolute http(s) URL without embedded credentials.",
		});
	});
});
