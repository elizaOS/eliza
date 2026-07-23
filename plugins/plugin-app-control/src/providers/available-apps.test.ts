/**
 * available_apps provider tests — the stale-while-revalidate snapshot that
 * keeps the planner compose off the two loopback /api/apps calls on warm
 * turns (#16873). The provider holds module-level snapshot state, so each
 * test resets modules and re-imports for an isolated snapshot.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	listInstalledApps: vi.fn(),
	listAppRuns: vi.fn(),
}));

vi.mock("../client/api.js", () => ({
	createAppControlClient: () => ({
		listInstalledApps: h.listInstalledApps,
		listAppRuns: h.listAppRuns,
	}),
}));

const RUNTIME = {} as IAgentRuntime;
const MESSAGE = {} as Memory;
const STATE = {} as State;

async function loadProvider() {
	vi.resetModules();
	const mod = await import("./available-apps.js");
	return mod.availableAppsProvider;
}

beforeEach(() => {
	h.listInstalledApps.mockReset();
	h.listAppRuns.mockReset();
	h.listInstalledApps.mockResolvedValue([
		{
			name: "chess",
			displayName: "Chess",
			pluginName: "@elizaos/plugin-chess",
			version: "1.0.0",
			installedAt: "",
		},
	]);
	h.listAppRuns.mockResolvedValue([
		{ runId: "r1", appName: "chess", displayName: "Chess", status: "running" },
	]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("availableAppsProvider snapshot", () => {
	it("returns empty text with zero calls-in-render when nothing is installed or running", async () => {
		h.listInstalledApps.mockResolvedValue([]);
		h.listAppRuns.mockResolvedValue([]);
		const provider = await loadProvider();
		const result = await provider.get(RUNTIME, MESSAGE, STATE);
		expect(result.text).toBe("");
	});

	it("renders installed apps and their running run counts on the cold turn", async () => {
		const provider = await loadProvider();
		const result = await provider.get(RUNTIME, MESSAGE, STATE);
		expect(result.text).toContain("available_apps:");
		expect(result.text).toContain("installedCount: 1");
		expect(result.text).toContain("runningCount: 1");
		expect(result.text).toContain("chess,Chess,@elizaos/plugin-chess,1");
		expect(result.values?.installedAppCount).toBe(1);
		expect(result.values?.runningAppCount).toBe(1);
		expect(h.listInstalledApps).toHaveBeenCalledTimes(1);
	});

	it("serves the snapshot without re-fetching inside the TTL", async () => {
		const provider = await loadProvider();
		await provider.get(RUNTIME, MESSAGE, STATE);
		expect(h.listInstalledApps).toHaveBeenCalledTimes(1);
		const second = await provider.get(RUNTIME, MESSAGE, STATE);
		// Warm turn is served from the cached snapshot — no second fetch.
		expect(h.listInstalledApps).toHaveBeenCalledTimes(1);
		expect(second.text).toContain("installedCount: 1");
	});

	it("returns the stale snapshot immediately and refreshes out-of-band past the TTL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const provider = await loadProvider();
		const first = await provider.get(RUNTIME, MESSAGE, STATE);
		expect(first.text).toContain("installedCount: 1");
		expect(h.listInstalledApps).toHaveBeenCalledTimes(1);

		// A second app appears; the very next warm-but-expired turn must still
		// serve the OLD snapshot synchronously, then refresh in the background.
		h.listInstalledApps.mockResolvedValue([
			{
				name: "chess",
				displayName: "Chess",
				pluginName: "@elizaos/plugin-chess",
				version: "1.0.0",
				installedAt: "",
			},
			{
				name: "poker",
				displayName: "Poker",
				pluginName: "@elizaos/plugin-poker",
				version: "1.0.0",
				installedAt: "",
			},
		]);

		vi.setSystemTime(Date.now() + 46_000);
		const stale = await provider.get(RUNTIME, MESSAGE, STATE);
		// Rendered synchronously from the pre-refresh snapshot (still count 1).
		expect(stale.text).toContain("installedCount: 1");

		// Let the background refresh settle: it re-fetched with the new count and
		// overwrote the snapshot. Poll a fresh render until it flips to count 2.
		await vi.waitFor(async () => {
			expect(h.listInstalledApps).toHaveBeenCalledTimes(2);
			const refreshed = await provider.get(RUNTIME, MESSAGE, STATE);
			expect(refreshed.text).toContain("installedCount: 2");
		});
	});

	it("degrades to empty context when a loopback call throws (never fails the turn)", async () => {
		h.listAppRuns.mockRejectedValue(new Error("loopback down"));
		const provider = await loadProvider();
		const result = await provider.get(RUNTIME, MESSAGE, STATE);
		expect(result.text).toBe("");
	});
});
