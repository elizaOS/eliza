/**
 * @module plugin-app-control/services/__tests__/app-worker-host
 *
 * Phase 2.2 integration test for AppWorkerHostService. Proves the
 * three load-bearing things for the rest of Phase 2:
 *
 *   1. The host can spawn a Bun worker_threads Worker with the
 *      app-worker-entry.ts file.
 *   2. A typed RPC round-trip (host → worker → host) carries a
 *      method name + params and returns a typed result.
 *   3. The latency of that round-trip on a small JSON payload is in
 *      the single-digit-ms range, so action invocation through the
 *      bridge is feasible without a heavier IPC layer.
 *
 * The test uses no agent runtime; AppWorkerHostService.spawn() is
 * called directly with a fixture SpawnOptions. The
 * `startForRegisteredApp` path that pulls from AppRegistryService is
 * exercised by Phase 2.5's end-to-end test once the registry plumbing
 * lands.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppWorkerHostService } from "../app-worker-host-service.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PLUGIN_PATH = path.resolve(
	path.dirname(__filename),
	"../../../test/fixtures/sandbox-plugin/plugin.ts",
);

describe("AppWorkerHostService — Phase 2.2 bridge", () => {
	let service: AppWorkerHostService;

	beforeEach(() => {
		service = new AppWorkerHostService(undefined);
	});

	afterEach(async () => {
		await service.stop();
	});

	it("spawns a worker and returns a snapshot with a thread id + readyMs", async () => {
		const snapshot = await service.spawn({
			slug: "fixture-bridge",
			isolation: "worker",
		});
		expect(snapshot.slug).toBe("fixture-bridge");
		expect(snapshot.pid).not.toBeNull();
		expect(snapshot.readyMs).not.toBeNull();
		expect(snapshot.readyMs).toBeLessThan(2_000);
	});

	it("ping round-trip returns the worker's slug + isolation", async () => {
		await service.spawn({ slug: "fixture-ping", isolation: "worker" });
		const reply = await service.invoke<{
			pong: boolean;
			slug: string;
			isolation: string;
		}>("fixture-ping", "ping");
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		expect(reply.result.pong).toBe(true);
		expect(reply.result.slug).toBe("fixture-ping");
		expect(reply.result.isolation).toBe("worker");
	});

	it("echo round-trip preserves a small JSON payload byte-for-byte", async () => {
		await service.spawn({ slug: "fixture-echo", isolation: "worker" });
		const payload = {
			s: "hello",
			n: 42,
			arr: [1, 2, 3],
			nested: { ok: true },
		};
		const reply = await service.invoke<typeof payload>(
			"fixture-echo",
			"echo",
			payload,
		);
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		expect(reply.result).toEqual(payload);
	});

	it("echo does not unwrap payloads that look like bridge envelopes", async () => {
		await service.spawn({ slug: "fixture-echo-envelope", isolation: "worker" });
		const payload = { ok: true, result: { nested: "literal payload" } };
		const reply = await service.invoke<typeof payload>(
			"fixture-echo-envelope",
			"echo",
			payload,
		);
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		expect(reply.result).toEqual(payload);
	});

	it("rejects unknown methods with a structured failure", async () => {
		await service.spawn({ slug: "fixture-unknown", isolation: "worker" });
		const reply = await service.invoke("fixture-unknown", "no-such-method");
		expect(reply.ok).toBe(false);
		if (reply.ok) return;
		expect(reply.reason).toContain("unknown method");
	});

	it("measures a usable round-trip latency over 100 echo calls", async () => {
		await service.spawn({ slug: "fixture-bench", isolation: "worker" });
		const samples: number[] = [];
		const payload = { ts: 0 };
		for (let i = 0; i < 100; i++) {
			payload.ts = i;
			const reply = await service.invoke("fixture-bench", "echo", payload);
			expect(reply.ok).toBe(true);
			samples.push(reply.durationMs);
		}
		samples.sort((a, b) => a - b);
		const p50 = samples[Math.floor(samples.length * 0.5)];
		const p95 = samples[Math.floor(samples.length * 0.95)];
		// Hard-fail well above realistic; the goal is to *measure* and
		// surface the number, not to pin it. If this trips the bridge
		// is genuinely too slow for action invocation.
		expect(p50).toBeLessThan(20);
		expect(p95).toBeLessThan(50);
		// Surface the number so failures are debuggable from the log.
		console.log(
			`[app-worker-host bench] echo round-trip p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms n=100`,
		);
	});

	it("stop sends shutdown and the worker exits within the grace period", async () => {
		await service.spawn({ slug: "fixture-stop", isolation: "worker" });
		expect(service.list().some((w) => w.slug === "fixture-stop")).toBe(true);
		await service.stopWorker("fixture-stop");
		expect(service.list().some((w) => w.slug === "fixture-stop")).toBe(false);
	});

	it("spawn is idempotent — second call for the same slug returns the existing snapshot", async () => {
		const first = await service.spawn({
			slug: "fixture-idempotent",
			isolation: "worker",
		});
		const second = await service.spawn({
			slug: "fixture-idempotent",
			isolation: "worker",
		});
		expect(second.pid).toBe(first.pid);
		expect(second.bootedAt).toBe(first.bootedAt);
	});

	describe("Phase 2.3 — plugin loading + action dispatch", () => {
		it("loads the fixture plugin and reports its actions in ping", async () => {
			await service.spawn({
				slug: "fixture-plugin-load",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
			});
			const reply = await service.invoke<{
				pong: boolean;
				actions: string[];
			}>("fixture-plugin-load", "ping");
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(reply.result.pong).toBe(true);
			expect(reply.result.actions.sort()).toEqual(["ECHO", "RUNTIME_PROBE"]);
		});

		it("invokeAction routes content to the fixture's ECHO handler and returns the result", async () => {
			await service.spawn({
				slug: "fixture-invoke-echo",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
			});
			const reply = await service.invoke<{ echoed: { msg: string } }>(
				"fixture-invoke-echo",
				"invokeAction",
				{ actionName: "ECHO", content: { msg: "hi from host" } },
			);
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(reply.result).toEqual({ echoed: { msg: "hi from host" } });
		});

		it("invokeAction surfaces the runtime stub's failure when an action touches IAgentRuntime", async () => {
			await service.spawn({
				slug: "fixture-invoke-probe",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
			});
			const reply = await service.invoke(
				"fixture-invoke-probe",
				"invokeAction",
				{ actionName: "RUNTIME_PROBE" },
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("worker sandbox");
		});

		it("invokeAction returns a structured failure for unknown actions", async () => {
			await service.spawn({
				slug: "fixture-invoke-unknown",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
			});
			const reply = await service.invoke(
				"fixture-invoke-unknown",
				"invokeAction",
				{ actionName: "DOES_NOT_EXIST" },
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("unknown action");
		});

		it("rejects spawn if the plugin entry path does not resolve", async () => {
			await expect(
				service.spawn({
					slug: "fixture-bad-plugin",
					isolation: "worker",
					pluginEntryPath: "/nonexistent/plugin.ts",
				}),
			).rejects.toThrow();
			expect(service.list().some((w) => w.slug === "fixture-bad-plugin")).toBe(
				false,
			);
		});
	});
});
