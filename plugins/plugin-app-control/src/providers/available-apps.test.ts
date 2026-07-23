/**
 * Runtime-scoped stale-while-revalidate coverage for the app inventory
 * provider. Cold and failed loopback reads remain explicit without blocking
 * compose, while successful empty inventory stays distinguishable from them.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
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

const MESSAGE = {} as Memory;
const STATE = {} as State;

function makeRuntime(): IAgentRuntime {
	return {
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

async function loadProvider(): Promise<Provider> {
	vi.resetModules();
	const mod = await import("./available-apps.js");
	return mod.availableAppsProvider;
}

async function waitForSnapshot(
	provider: Provider,
	runtime: IAgentRuntime,
	status: "ready" | "error" = "ready",
) {
	await vi.waitFor(async () => {
		const result = await provider.get(runtime, MESSAGE, STATE);
		expect(result.values?.availableAppsStatus).toBe(status);
	});
	return provider.get(runtime, MESSAGE, STATE);
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
	it("returns an explicit loading state without awaiting the cold loopback reads", async () => {
		let resolveInstalled!: (value: unknown[]) => void;
		let resolveRuns!: (value: unknown[]) => void;
		h.listInstalledApps.mockReturnValue(
			new Promise((resolve) => {
				resolveInstalled = resolve;
			}),
		);
		h.listAppRuns.mockReturnValue(
			new Promise((resolve) => {
				resolveRuns = resolve;
			}),
		);
		const runtime = makeRuntime();
		const provider = await loadProvider();

		const cold = await provider.get(runtime, MESSAGE, STATE);
		expect(cold.values?.availableAppsStatus).toBe("loading");
		expect(cold.text).toContain("status: loading");

		resolveInstalled([]);
		resolveRuns([]);
		const ready = await waitForSnapshot(provider, runtime);
		expect(ready.text).toBe("");
		expect(ready.values?.installedAppCount).toBe(0);
	});

	it("renders installed apps after the out-of-band cold refresh", async () => {
		const runtime = makeRuntime();
		const provider = await loadProvider();
		const cold = await provider.get(runtime, MESSAGE, STATE);
		expect(cold.values?.availableAppsStatus).toBe("loading");

		const result = await waitForSnapshot(provider, runtime);
		expect(result.text).toContain("available_apps:");
		expect(result.text).toContain("status: ready");
		expect(result.text).toContain("installedCount: 1");
		expect(result.text).toContain("runningCount: 1");
		expect(result.text).toContain("chess,Chess,@elizaos/plugin-chess,1");
		expect(result.values?.installedAppCount).toBe(1);
		expect(result.values?.runningAppCount).toBe(1);
		expect(h.listInstalledApps).toHaveBeenCalledTimes(1);
	});

	it("serves the snapshot without re-fetching inside the TTL", async () => {
		const runtime = makeRuntime();
		const provider = await loadProvider();
		await provider.get(runtime, MESSAGE, STATE);
		await waitForSnapshot(provider, runtime);

		const second = await provider.get(runtime, MESSAGE, STATE);
		expect(h.listInstalledApps).toHaveBeenCalledTimes(1);
		expect(second.text).toContain("installedCount: 1");
	});

	it("returns stale data immediately while refreshing past the TTL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const runtime = makeRuntime();
		const provider = await loadProvider();
		await provider.get(runtime, MESSAGE, STATE);
		const first = await waitForSnapshot(provider, runtime);
		expect(first.text).toContain("installedCount: 1");

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
		const stale = await provider.get(runtime, MESSAGE, STATE);
		expect(stale.text).toContain("installedCount: 1");

		await vi.waitFor(async () => {
			expect(h.listInstalledApps).toHaveBeenCalledTimes(2);
			const refreshed = await provider.get(runtime, MESSAGE, STATE);
			expect(refreshed.text).toContain("installedCount: 2");
		});
	});

	it("reports loopback failure and serves an explicit unavailable state", async () => {
		h.listAppRuns.mockRejectedValue(new Error("loopback down"));
		const runtime = makeRuntime();
		const provider = await loadProvider();

		const cold = await provider.get(runtime, MESSAGE, STATE);
		expect(cold.values?.availableAppsStatus).toBe("loading");
		const failed = await waitForSnapshot(provider, runtime, "error");

		expect(failed.text).toContain("status: unavailable");
		expect(runtime.reportError).toHaveBeenCalledWith(
			"availableAppsProvider.refresh",
			expect.any(Error),
			{ provider: "available_apps" },
		);
	});

	it("keeps snapshots isolated between runtimes", async () => {
		const firstRuntime = makeRuntime();
		const secondRuntime = makeRuntime();
		const provider = await loadProvider();

		await provider.get(firstRuntime, MESSAGE, STATE);
		await waitForSnapshot(provider, firstRuntime);
		await provider.get(secondRuntime, MESSAGE, STATE);
		await waitForSnapshot(provider, secondRuntime);

		expect(h.listInstalledApps).toHaveBeenCalledTimes(2);
	});
});
