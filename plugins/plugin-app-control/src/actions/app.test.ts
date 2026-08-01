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
				text: expect.stringContaining("only the owner"),
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

	it.each(["delete all my apps", "uninstall the chess app"])(
		"answers %j with the designed refusal owning user-facing prose",
		async (text) => {
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
					userFacingText: expect.stringContaining("can't bulk-delete"),
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
