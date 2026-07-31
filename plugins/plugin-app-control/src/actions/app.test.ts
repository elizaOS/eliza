/**
 * APP tests cover owner policy and the callback-silent local inventory path
 * through the public action handler.
 */

import type { ActionResult, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import { createAppAction } from "./app.js";

describe("APP action role policy", () => {
	it("advertises the same owner-only gate enforced by validate and handler", () => {
		expect(createAppAction().roleGate).toEqual({ minRole: "OWNER" });
	});

	it("returns local inventory without posting the machine table as a callback", async () => {
		const client: AppControlClient = {
			listInstalledApps: vi.fn(async () => [
				{
					name: "notes",
					displayName: "Notes",
					pluginName: "plugin-notes",
					version: "1.0.0",
					installedAt: "2026-07-30T00:00:00.000Z",
				},
			]),
			listAppRuns: vi.fn(async () => []),
			launchApp: vi.fn(async () => {
				throw new Error("launch is outside this test");
			}),
			stopAppRun: vi.fn(async () => {
				throw new Error("stop is outside this test");
			}),
		};
		const action = createAppAction({
			client,
			hasOwnerAccess: async () => true,
		});
		const callback = vi.fn(async () => []);
		const message = {
			id: "00000000-0000-0000-0000-000000000001" as UUID,
			entityId: "00000000-0000-0000-0000-000000000002" as UUID,
			agentId: "00000000-0000-0000-0000-000000000003" as UUID,
			roomId: "00000000-0000-0000-0000-000000000004" as UUID,
			content: { text: "list installed apps" },
		} as Memory;

		const result = (await action.handler?.(
			{ agentId: message.agentId } as IAgentRuntime,
			message,
			undefined,
			{ action: "list" },
			callback,
		)) as ActionResult;

		expect(result.success).toBe(true);
		expect(result.text).toContain("available_apps:");
		expect(result.text).toContain("notes,Notes,none");
		expect(callback).not.toHaveBeenCalled();
		expect(client.listInstalledApps).toHaveBeenCalledTimes(1);
		expect(client.listAppRuns).toHaveBeenCalledTimes(1);
	});
});
