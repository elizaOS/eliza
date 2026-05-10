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

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
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
			expect(reply.result.actions.sort()).toEqual([
				"ECHO",
				"FS_ESCAPE_ATTEMPT",
				"FS_WRITE_THEN_READ",
				"NET_FETCH",
				"RUNTIME_PROBE",
			]);
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

	describe("Phase 2.4 — fs + net capability gates", () => {
		let httpServer: http.Server;
		let httpServerUrl: string;
		let stateRoot: string;

		beforeEach(async () => {
			httpServer = http.createServer((_req, res) => {
				res.writeHead(204);
				res.end();
			});
			await new Promise<void>((resolve) =>
				httpServer.listen(0, "127.0.0.1", () => resolve()),
			);
			const addr = httpServer.address();
			if (typeof addr === "string" || addr === null) {
				throw new Error("expected AddressInfo");
			}
			httpServerUrl = `http://127.0.0.1:${addr.port}/`;
			stateRoot = mkdtempSync(path.join(tmpdir(), "app-worker-fs-"));
		});

		afterEach(async () => {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			rmSync(stateRoot, { recursive: true, force: true });
		});

		it("net: rejects when grantedNamespaces does not include 'net'", async () => {
			await service.spawn({
				slug: "fixture-net-not-granted",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				requestedPermissions: { net: { outbound: ["127.0.0.1"] } },
				grantedNamespaces: [],
			});
			const reply = await service.invoke(
				"fixture-net-not-granted",
				"invokeAction",
				{ actionName: "NET_FETCH", content: { url: httpServerUrl } },
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("net access not granted");
		});

		it("net: rejects when host does not match manifest outbound list", async () => {
			await service.spawn({
				slug: "fixture-net-wrong-host",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				requestedPermissions: { net: { outbound: ["api.example.com"] } },
				grantedNamespaces: ["net"],
			});
			const reply = await service.invoke(
				"fixture-net-wrong-host",
				"invokeAction",
				{ actionName: "NET_FETCH", content: { url: httpServerUrl } },
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("not allowed by manifest");
		});

		it("net: succeeds when grant + manifest both allow", async () => {
			await service.spawn({
				slug: "fixture-net-allowed",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				requestedPermissions: { net: { outbound: ["127.0.0.1"] } },
				grantedNamespaces: ["net"],
			});
			const reply = await service.invoke<{ status: number }>(
				"fixture-net-allowed",
				"invokeAction",
				{ actionName: "NET_FETCH", content: { url: httpServerUrl } },
			);
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(reply.result.status).toBe(204);
		});

		it("net: rejects non-http protocols even when manifest allows all hosts", async () => {
			await service.spawn({
				slug: "fixture-net-file-protocol",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				requestedPermissions: { net: { outbound: ["*"] } },
				grantedNamespaces: ["net"],
			});
			const reply = await service.invoke(
				"fixture-net-file-protocol",
				"invokeAction",
				{ actionName: "NET_FETCH", content: { url: "file:///etc/passwd" } },
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("http/https");
		});

		it("fs: round-trips a write+read inside statePath", async () => {
			await service.spawn({
				slug: "fixture-fs-ok",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				statePath: stateRoot,
				requestedPermissions: { fs: { read: ["**"], write: ["**"] } },
				grantedNamespaces: ["fs"],
			});
			const reply = await service.invoke<{ read: string }>(
				"fixture-fs-ok",
				"invokeAction",
				{
					actionName: "FS_WRITE_THEN_READ",
					content: { relPath: "hello.txt", payload: "from worker" },
				},
			);
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(reply.result.read).toBe("from worker");
		});

		it("fs: rejects when grantedNamespaces does not include 'fs'", async () => {
			await service.spawn({
				slug: "fixture-fs-not-granted",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				statePath: stateRoot,
				requestedPermissions: { fs: { read: ["**"], write: ["**"] } },
				grantedNamespaces: [],
			});
			const reply = await service.invoke(
				"fixture-fs-not-granted",
				"invokeAction",
				{
					actionName: "FS_WRITE_THEN_READ",
					content: { relPath: "x.txt", payload: "denied" },
				},
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("fs access not granted");
		});

		it("fs: rejects write when the manifest only declared read", async () => {
			await service.spawn({
				slug: "fixture-fs-write-not-declared",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				statePath: stateRoot,
				requestedPermissions: { fs: { read: ["**"] } },
				grantedNamespaces: ["fs"],
			});
			const reply = await service.invoke(
				"fixture-fs-write-not-declared",
				"invokeAction",
				{
					actionName: "FS_WRITE_THEN_READ",
					content: { relPath: "x.txt", payload: "denied" },
				},
			);
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("fs.write access not allowed");
		});

		it("fs: rejects path-escape attempts outside statePath", async () => {
			await service.spawn({
				slug: "fixture-fs-escape",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				statePath: stateRoot,
				requestedPermissions: { fs: { read: ["**"] } },
				grantedNamespaces: ["fs"],
			});
			const reply = await service.invoke("fixture-fs-escape", "invokeAction", {
				actionName: "FS_ESCAPE_ATTEMPT",
				content: { absolutePath: "/etc/passwd" },
			});
			expect(reply.ok).toBe(false);
			if (reply.ok) return;
			expect(reply.reason).toContain("escapes the sandbox statePath");
		});
	});
});
