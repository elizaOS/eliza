/**
 * APP contract coverage keeps its owner gate, planner schema, deterministic
 * stop routing, and typed stop result aligned with the dashboard lifecycle
 * route.
 */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
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
		const callback: HandlerCallback = vi.fn(async () => undefined);
		const result = await action.handler(
			{ agentId: "agent-1" } as IAgentRuntime,
			{
				entityId: "viewer-1",
				content: { text: "stop the chess app" },
			} as Memory,
			undefined,
			{ parameters: { action: "stop", app: "chess" } },
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				text: expect.stringContaining("only the owner"),
				userFacingText: "Sorry — only my owner can manage apps.",
				verifiedUserFacing: true,
				turnComplete: true,
				values: { permissionDenied: true },
			}),
		);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith({
			text: "Sorry — only my owner can manage apps.",
		});
		expect(client.listInstalledApps).not.toHaveBeenCalled();
		expect(client.stopApp).not.toHaveBeenCalled();
	});
});

describe("APP stop mode", () => {
	it("leaves ambiguous mode clarification to the planner", async () => {
		const client: AppControlClient = {
			listInstalledApps: vi.fn(),
			listAppRuns: vi.fn(),
			launchApp: vi.fn(),
			stopApp: vi.fn(),
			stopAppRun: vi.fn(),
		};
		const action = createAppAction({
			client,
			hasOwnerAccess: async () => true,
		});
		const callback: HandlerCallback = vi.fn(async () => undefined);

		const result = await action.handler(
			{ agentId: "agent-1" } as IAgentRuntime,
			{
				entityId: "owner-1",
				content: { text: "manage an app" },
			} as Memory,
			undefined,
			undefined,
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: false,
				text: expect.stringContaining("ask the user"),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
		expect(client.listInstalledApps).not.toHaveBeenCalled();
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
