/**
 * APP contract coverage keeps its owner gate, planner schema, deterministic
 * stop routing, and typed stop result aligned with the dashboard lifecycle
 * route.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import { createAppAction } from "./app.js";

describe("APP action role policy", () => {
	it("advertises the same owner-only gate enforced by validate and handler", () => {
		expect(createAppAction().roleGate).toEqual({ minRole: "OWNER" });
	});

	it("denies stop before any app-control request when the caller is not the owner", async () => {
		const client: AppControlClient = {
			listInstalledApps: vi.fn(),
			listAppRuns: vi.fn(),
			launchApp: vi.fn(),
			stopApp: vi.fn(),
			stopAppRun: vi.fn(),
		};
		const action = createAppAction({
			client,
			hasOwnerAccess: async () => false,
		});
		const result = await action.handler(
			{ agentId: "agent-1" } as IAgentRuntime,
			{
				entityId: "viewer-1",
				content: { text: "stop the chess app" },
			} as Memory,
			undefined,
			{ parameters: { action: "stop", app: "chess" } },
			undefined,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: false,
				text: expect.stringContaining("only my owner"),
			}),
		);
		expect(client.listInstalledApps).not.toHaveBeenCalled();
		expect(client.stopApp).not.toHaveBeenCalled();
	});
});

describe("APP delete refusal", () => {
	function ownerAction(client: AppControlClient) {
		return createAppAction({ client, hasOwnerAccess: async () => true });
	}

	function untouchedClient(): AppControlClient {
		return {
			listInstalledApps: vi.fn(),
			listAppRuns: vi.fn(),
			launchApp: vi.fn(),
			stopApp: vi.fn(),
			stopAppRun: vi.fn(),
		};
	}

	it.each([
		["delete all my apps", "can't bulk-delete"],
		["uninstall the chess app", "can't uninstall apps through APP"],
	])(
		"answers %j with the designed refusal owning user-facing prose",
		async (text, expectedText) => {
			const client = untouchedClient();
			const result = await ownerAction(client).handler(
				{ agentId: "agent-1" } as IAgentRuntime,
				{ entityId: "owner-1", content: { text } } as Memory,
				undefined,
				undefined,
				undefined,
			);

			expect(result).toEqual(
				expect.objectContaining({
					success: false,
					userFacingText: expect.stringContaining(expectedText),
					data: expect.objectContaining({ error: "DELETE_UNSUPPORTED" }),
				}),
			);
			// The refusal is terminal for APP: no loopback calls are made.
			expect(client.listInstalledApps).not.toHaveBeenCalled();
			expect(client.stopApp).not.toHaveBeenCalled();
		},
	);

	it("keeps 'kill the chess app' routed to stop, not the delete refusal", async () => {
		const stopApp = vi.fn(async () => ({
			success: true,
			appName: "chess",
			runId: null,
			stoppedAt: "2026-07-31T00:00:00.000Z",
			pluginUninstalled: false,
			needsRestart: false,
			stopScope: "viewer-session" as const,
			message: "Chess stopped.",
		}));
		const client: AppControlClient = {
			listInstalledApps: async () => [
				{
					name: "chess",
					displayName: "Chess",
					pluginName: "@test/chess",
					version: "1.0.0",
					installedAt: "2026-07-31T00:00:00.000Z",
				},
			],
			listAppRuns: async () => [],
			launchApp: vi.fn(),
			stopApp,
			stopAppRun: vi.fn(),
		};

		const result = await ownerAction(client).handler(
			{ agentId: "agent-1" } as IAgentRuntime,
			{
				entityId: "owner-1",
				content: { text: "kill the chess app" },
			} as Memory,
			undefined,
			undefined,
			undefined,
		);

		expect(stopApp).toHaveBeenCalledWith("chess");
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				values: expect.objectContaining({ mode: "stop" }),
			}),
		);
	});
});

describe("APP stop mode", () => {
	it.each(["close Eliza app", "hide Eliza", "quit Eliza"])(
		"dismisses only the Workspace for %j and never touches registered apps",
		async (text) => {
			const client: AppControlClient = {
				listInstalledApps: vi.fn(),
				listAppRuns: vi.fn(),
				launchApp: vi.fn(),
				stopApp: vi.fn(),
				stopAppRun: vi.fn(),
			};
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).endsWith("/api/views/current")) {
					return new Response(
						JSON.stringify({
							currentView: {
								viewId: "notes",
								viewPath: "/notes",
								viewLabel: "Notes",
								viewType: "gui",
								updatedAt: "2026-08-20T00:00:00.000Z",
							},
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			});
			vi.stubGlobal("fetch", fetchMock);
			try {
				const action = createAppAction({
					client,
					hasOwnerAccess: async () => true,
				});
				const result = await action.handler(
					{ agentId: "agent-1" } as IAgentRuntime,
					{
						entityId: "owner-1",
						content: {
							text,
							metadata: { viewClientId: "desktop-pill-1" },
						},
					} as Memory,
					undefined,
					undefined,
					undefined,
				);

				expect(result).toMatchObject({
					success: true,
					text: "Closed the Workspace.",
					data: { target: "workspace", closed: true },
				});
				expect(client.listInstalledApps).not.toHaveBeenCalled();
				expect(client.stopApp).not.toHaveBeenCalled();
				expect(fetchMock).toHaveBeenLastCalledWith(
					expect.stringMatching(
						/^http:\/\/127\.0\.0\.1:\d+\/api\/views\/__workspace__\/navigate$/,
					),
					expect.objectContaining({
						method: "POST",
						body: JSON.stringify({
							action: "close",
							alwaysOnTop: false,
							delivery: "completed-action",
							clientId: "desktop-pill-1",
						}),
					}),
				);
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);

	it("answers accurately when the Workspace is already closed", async () => {
		const client: AppControlClient = {
			listInstalledApps: vi.fn(),
			listAppRuns: vi.fn(),
			launchApp: vi.fn(),
			stopApp: vi.fn(),
			stopAppRun: vi.fn(),
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ currentView: null }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await createAppAction({
				client,
				hasOwnerAccess: async () => true,
			}).handler(
				{ agentId: "agent-1" } as IAgentRuntime,
				{ entityId: "owner-1", content: { text: "quit Eliza" } } as Memory,
				undefined,
				undefined,
				undefined,
			);

			expect(result).toMatchObject({
				success: true,
				text: "The Workspace is already closed.",
				data: { target: "workspace", closed: false },
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("advertises stop as a typed planner operation", () => {
		const actionParameter = createAppAction().parameters?.find(
			(parameter) => parameter.name === "action",
		);
		expect(actionParameter?.schema).toEqual(
			expect.objectContaining({
				enum: expect.arrayContaining(["launch", "relaunch", "stop"]),
			}),
		);
	});

	it("routes a standalone stop request without relaunching the app", async () => {
		const stopApp = vi.fn(async () => ({
			success: true,
			appName: "chess",
			runId: null,
			stoppedAt: "2026-07-23T00:00:00.000Z",
			pluginUninstalled: false,
			needsRestart: false,
			stopScope: "viewer-session" as const,
			message: "Chess stopped.",
		}));
		const client: AppControlClient = {
			listInstalledApps: async () => [
				{
					name: "chess",
					displayName: "Chess",
					pluginName: "@test/chess",
					version: "1.0.0",
					installedAt: "2026-07-23T00:00:00.000Z",
				},
			],
			listAppRuns: async () => [],
			launchApp: vi.fn(),
			stopApp,
			stopAppRun: vi.fn(),
		};
		const action = createAppAction({
			client,
			hasOwnerAccess: async () => true,
		});
		const runtime = { agentId: "agent-1" } as IAgentRuntime;
		const message = {
			entityId: "owner-1",
			content: { text: "stop the chess app" },
		} as Memory;

		const result = await action.handler(
			runtime,
			message,
			undefined,
			undefined,
			undefined,
		);

		expect(stopApp).toHaveBeenCalledWith("chess");
		expect(client.launchApp).not.toHaveBeenCalled();
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				values: expect.objectContaining({
					mode: "stop",
					appName: "chess",
					stopScope: "viewer-session",
				}),
			}),
		);
	});
});

describe("APP launch handler delivery", () => {
	it("carries the originating renderer through the real action handler", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Record<string, unknown>[] = [];
		globalThis.fetch = vi.fn(async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			return new Response(
				JSON.stringify({
					ok: true,
					completedActionDelivered: true,
					completedActionHandoffId: body.completedActionHandoffId,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		const client: AppControlClient = {
			listInstalledApps: async () => [
				{
					name: "demo",
					displayName: "Demo",
					pluginName: "demo",
					version: "1.0.0",
					installedAt: "2026-08-21T00:00:00.000Z",
				},
			],
			listAppRuns: vi.fn(),
			launchApp: async () => ({
				pluginInstalled: true,
				needsRestart: false,
				displayName: "Demo",
				launchType: "local",
				launchUrl: "/api/apps/local/demo/",
				run: null,
			}),
			stopApp: vi.fn(),
			stopAppRun: vi.fn(),
		};

		try {
			const action = createAppAction({
				client,
				hasOwnerAccess: async () => true,
			});
			const result = await action.handler(
				{ agentId: "agent-1" } as IAgentRuntime,
				{
					entityId: "owner-1",
					content: {
						text: "launch demo",
						metadata: { viewClientId: "origin-renderer" },
					},
				} as Memory,
				undefined,
				{ parameters: { action: "launch", app: "demo" } },
				undefined,
			);

			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				clientId: "origin-renderer",
				delivery: "completed-action",
			});
			expect(result.values).toMatchObject({
				mode: "launch",
				viewId: "browser",
				openedInBrowser: true,
				completedActionDelivered: true,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
