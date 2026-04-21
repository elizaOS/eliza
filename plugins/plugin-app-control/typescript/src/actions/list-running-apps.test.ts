/**
 * @module plugin-app-control/actions/list-running-apps.test
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import type { AppRunSummary } from "../types.js";
import { createListRunningAppsAction } from "./list-running-apps.js";

function makeRun(overrides: Partial<AppRunSummary> = {}): AppRunSummary {
	return {
		runId: "run_abc",
		appName: "@elizaos/app-companion",
		displayName: "Companion",
		pluginName: "@elizaos/app-companion",
		launchType: "viewer",
		launchUrl: null,
		status: "active",
		summary: null,
		startedAt: "2026-04-21T00:00:00.000Z",
		updatedAt: "2026-04-21T00:00:00.000Z",
		lastHeartbeatAt: null,
		...overrides,
	};
}

function stubRuntime(): IAgentRuntime {
	return {} as IAgentRuntime;
}

function stubMessage(text: string): Memory {
	return { content: { text } } as unknown as Memory;
}

function stubClient(partial: Partial<AppControlClient>): AppControlClient {
	return {
		listInstalledApps: vi.fn(async () => []),
		listAppRuns: vi.fn(async () => []),
		launchApp: vi.fn(async () => {
			throw new Error("launchApp not stubbed");
		}),
		stopAppRun: vi.fn(async () => {
			throw new Error("stopAppRun not stubbed");
		}),
		stopAppByName: vi.fn(async () => {
			throw new Error("stopAppByName not stubbed");
		}),
		...partial,
	};
}

function makeCallback(): HandlerCallback & {
	mock: ReturnType<typeof vi.fn>["mock"];
} {
	return vi.fn(async () => []) as unknown as HandlerCallback & {
		mock: ReturnType<typeof vi.fn>["mock"];
	};
}

function expectResult(result: ActionResult | undefined): ActionResult {
	if (!result) {
		throw new Error("Action handler returned undefined");
	}
	return result;
}

describe("LIST_RUNNING_APPS action", () => {
	it("formats a happy-path snapshot of running apps", async () => {
		const runs: AppRunSummary[] = [
			makeRun({
				runId: "run_a",
				displayName: "Shopify",
				appName: "@elizaos/app-shopify",
				pluginName: "@elizaos/app-shopify",
				status: "active",
			}),
			makeRun({
				runId: "run_b",
				displayName: "Companion",
				appName: "@elizaos/app-companion",
				pluginName: "@elizaos/app-companion",
				status: "active",
			}),
		];
		const client = stubClient({ listAppRuns: vi.fn(async () => runs) });
		const action = createListRunningAppsAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("list running apps"),
				undefined,
				undefined,
				callback,
			),
		);

		expect(result.success).toBe(true);
		expect(result.values?.runCount).toBe(2);
		expect(result.data).toEqual({ runs });
		const text = String(callback.mock.calls[0][0].text);
		expect(text).toContain("2 apps running");
		expect(text).toContain("Shopify");
		expect(text).toContain("run_a");
		expect(text).toContain("Companion");
		expect(text).toContain("run_b");
	});

	it("returns an empty-state message when no apps are running", async () => {
		const client = stubClient({ listAppRuns: vi.fn(async () => []) });
		const action = createListRunningAppsAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("what apps are open?"),
				undefined,
				undefined,
				callback,
			),
		);

		expect(result.success).toBe(true);
		expect(result.values?.runCount).toBe(0);
		expect(String(callback.mock.calls[0][0].text)).toContain(
			"No apps are currently running",
		);
	});

	it("propagates a runtime error from listAppRuns", async () => {
		const client = stubClient({
			listAppRuns: vi.fn(async () => {
				throw new Error("API unreachable");
			}),
		});
		const action = createListRunningAppsAction({ client });

		await expect(
			action.handler(
				stubRuntime(),
				stubMessage("list running apps"),
				undefined,
				undefined,
			),
		).rejects.toThrow("API unreachable");
	});
});
