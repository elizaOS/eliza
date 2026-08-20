/**
 * @module plugin-app-control/services/__tests__/app-worker-host
 *
 * Integration coverage for AppWorkerHostService. Proves the three
 * load-bearing worker-host contracts:
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
 * `startForRegisteredApp` path that pulls from AppRegistryService is covered
 * by the registry-to-worker end-to-end test.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppWorkerHostService } from "../app-worker-host-service.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PLUGIN_PATH = path.resolve(
	path.dirname(__filename),
	"../../../test/fixtures/sandbox-plugin/plugin.ts",
);
const NO_ACTIONS_PLUGIN_PATH = path.resolve(
	path.dirname(__filename),
	"../../../test/fixtures/no-actions-plugin/plugin.ts",
);
const SHADOWED_ACTIONS_PLUGIN_PATH = path.resolve(
	path.dirname(__filename),
	"../../../test/fixtures/shadowed-actions-plugin/plugin.ts",
);

describe("AppWorkerHostService worker bridge", () => {
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
		// readyMs is spawn + worker module-load latency, dominated by the OS
		// thread/process spawn cost — NOT the RPC round-trip (that budget is asserted
		// separately by the p50/p95 echo bench). On a loaded, contended self-hosted
		// CI host — Windows especially, where process spawn is heavy — worker startup
		// routinely runs several seconds, so a tight budget flakes on the environment
		// rather than catching a regression. This generous ceiling only trips on a
		// genuine spawn hang; the per-test timeout backstops a true never-ready.
		expect(snapshot.readyMs).toBeLessThan(15_000);
	}, 30_000);

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

	describe("plugin loading + action dispatch", () => {
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

		it("invokeAction bridges runtime.getMemories to the host runtime", async () => {
			const calls: unknown[] = [];
			const runtimeBackedService = new AppWorkerHostService({
				agentId: "00000000-0000-0000-0000-000000000001",
				getMemories: async (params: unknown) => {
					calls.push(params);
					return [
						{
							id: "memory-1",
							content: { text: "from host runtime" },
						},
					];
				},
			} as unknown as IAgentRuntime);
			await runtimeBackedService.spawn({
				slug: "fixture-invoke-probe",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
			});
			const reply = await runtimeBackedService.invoke(
				"fixture-invoke-probe",
				"invokeAction",
				{ actionName: "RUNTIME_PROBE" },
			);
			await runtimeBackedService.stop();
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(calls).toEqual([{ tableName: "messages", limit: 2 }]);
			expect(reply.result).toEqual([
				{
					id: "memory-1",
					content: { text: "from host runtime" },
				},
			]);
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

		it("rejects a providers/routes-only plugin with an explicit failure (no false success)", async () => {
			// Regression for #18240 + jmforj review: a plugin that contributes
			// only providers/routes/services has no reachable surface inside the
			// worker sandbox (which only bridges actions). The original fix
			// emitted a `warn` message the host silently dropped — producing a
			// healthy-looking but inert worker. This now fails explicitly so a
			// misconfigured isolation:"worker" app is surfaced as a config error.
			await expect(
				service.spawn({
					slug: "fixture-no-actions",
					isolation: "worker",
					pluginEntryPath: NO_ACTIONS_PLUGIN_PATH,
				}),
			).rejects.toThrow(/contributes no actions/);
			expect(service.list().some((w) => w.slug === "fixture-no-actions")).toBe(
				false,
			);
		});

		it("prefers an actions-bearing named export over a metadata-only default export", async () => {
			// A metadata-only default export is a valid plugin shape; if
			// candidate selection stopped at the first valid export it would
			// shadow the sibling actions-bearing `plugin` export and the
			// zero-action gate would reject a module the worker can serve.
			await service.spawn({
				slug: "fixture-shadowed-actions",
				isolation: "worker",
				pluginEntryPath: SHADOWED_ACTIONS_PLUGIN_PATH,
			});
			const reply = await service.invoke<{
				pong: boolean;
				actions: string[];
			}>("fixture-shadowed-actions", "ping");
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(reply.result.actions).toEqual(["SHADOWED_ECHO"]);
		});
	});

	describe("fs + net capability gates", () => {
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

		it("fs: creates and round-trips nested directories inside statePath", async () => {
			await service.spawn({
				slug: "fixture-fs-nested-ok",
				isolation: "worker",
				pluginEntryPath: FIXTURE_PLUGIN_PATH,
				statePath: stateRoot,
				requestedPermissions: { fs: { read: ["**"], write: ["**"] } },
				grantedNamespaces: ["fs"],
			});
			const reply = await service.invoke<{ read: string }>(
				"fixture-fs-nested-ok",
				"invokeAction",
				{
					actionName: "FS_WRITE_THEN_READ",
					content: { relPath: "a/b/c.txt", payload: "nested" },
				},
			);
			expect(reply.ok).toBe(true);
			if (!reply.ok) return;
			expect(reply.result.read).toBe("nested");
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
			expect(reply.code).toBe("APP_WORKER_FS_ESCAPE");
		});

		it.skipIf(process.platform === "win32")(
			"fs: rejects final-component symlinks for reads and writes",
			async () => {
				const outside = path.join(
					tmpdir(),
					`app-worker-fs-outside-${Date.now()}.txt`,
				);
				writeFileSync(outside, "SECRET_PAYLOAD_OUTSIDE_SANDBOX");
				const link = path.join(stateRoot, "escape-link");
				symlinkSync(outside, link);
				try {
					await service.spawn({
						slug: "fixture-fs-symlink",
						isolation: "worker",
						pluginEntryPath: FIXTURE_PLUGIN_PATH,
						statePath: stateRoot,
						requestedPermissions: { fs: { read: ["**"], write: ["**"] } },
						grantedNamespaces: ["fs"],
					});
					const readReply = await service.invoke(
						"fixture-fs-symlink",
						"invokeAction",
						{
							actionName: "FS_ESCAPE_ATTEMPT",
							content: { absolutePath: link },
						},
					);
					expect(readReply.ok).toBe(false);
					if (readReply.ok) return;
					expect(readReply.code).toBe("APP_WORKER_FS_UNSAFE_TARGET");

					const writeReply = await service.invoke(
						"fixture-fs-symlink",
						"invokeAction",
						{
							actionName: "FS_WRITE_THEN_READ",
							content: { relPath: "escape-link", payload: "overwrite" },
						},
					);
					expect(writeReply.ok).toBe(false);
					expect(readFileSync(outside, "utf8")).toBe(
						"SECRET_PAYLOAD_OUTSIDE_SANDBOX",
					);
				} finally {
					rmSync(outside, { force: true });
				}
			},
		);

		it("fs: rejects a symlink grandparent before creating missing directories", async () => {
			const outsideRoot = mkdtempSync(
				path.join(tmpdir(), "app-worker-fs-outside-dir-"),
			);
			const link = path.join(stateRoot, "escape-dir");
			symlinkSync(
				outsideRoot,
				link,
				process.platform === "win32" ? "junction" : "dir",
			);
			try {
				await service.spawn({
					slug: "fixture-fs-symlink-grandparent",
					isolation: "worker",
					pluginEntryPath: FIXTURE_PLUGIN_PATH,
					statePath: stateRoot,
					requestedPermissions: { fs: { read: ["**"], write: ["**"] } },
					grantedNamespaces: ["fs"],
				});
				const reply = await service.invoke(
					"fixture-fs-symlink-grandparent",
					"invokeAction",
					{
						actionName: "FS_WRITE_THEN_READ",
						content: {
							relPath: "escape-dir/missing/secret.txt",
							payload: "overwrite",
						},
					},
				);
				expect(reply.ok).toBe(false);
				if (reply.ok) return;
				expect(reply.code).toBe("APP_WORKER_FS_UNSAFE_COMPONENT");
				expect(existsSync(path.join(outsideRoot, "missing"))).toBe(false);
			} finally {
				rmSync(outsideRoot, { recursive: true, force: true });
			}
		});
	});

	// `trust: "external"` promotes EVERY registered app to isolation:"worker",
	// including static frontend apps that ship no agent-side module. Those apps
	// declare `main: "./dist/index.js"` for their bundler; the file is not a
	// plugin and often is not built. Resolving through to some source file the
	// package never pointed at made every one of them boot, import a React
	// entry, and report "no plugin export found in module" — 20 warnings per
	// boot on a real install, burying the spawns that actually broke.
	describe("apps with no worker surface are classified, not failed", () => {
		function makeRegistryRuntime(entry: Record<string, unknown>) {
			return {
				agentId: "00000000-0000-0000-0000-000000000001",
				getService: (type: string) =>
					type === "app-registry"
						? {
								list: async () => [entry],
								getPermissionsView: async () => null,
							}
						: null,
			} as unknown as IAgentRuntime;
		}

		function validPluginSource(name: string): string {
			return `export default {
	name: "${name}",
	actions: [{
		name: "SOURCE_PING",
		description: "fixture",
		similes: [],
		validate: async () => true,
		handler: async () => ({ success: true }),
	}],
};\n`;
		}

		it("keeps an explicitly static app out of the worker host", async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "app-static-"));
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "static-app", main: "./dist/index.js" }),
			);
			mkdirSync(path.join(dir, "src"), { recursive: true });
			writeFileSync(
				path.join(dir, "src", "index.ts"),
				"export const ui = 1;\n",
			);

			const svc = new AppWorkerHostService(
				makeRegistryRuntime({
					slug: "static-app",
					directory: dir,
					isolation: "worker",
					worker: false,
				}),
			);
			const result = await svc.startForRegisteredApp("static-app");
			rmSync(dir, { recursive: true, force: true });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			// Classified as "no surface", so the caller logs it at debug.
			expect(result.kind).toBe("no-worker-surface");
			expect(result.reason).toContain("explicitly declares no worker surface");
		});

		it("boots a valid source plugin when its declared build is absent", async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "app-undeclared-"));
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "source-plugin", main: "./dist/index.js" }),
			);
			mkdirSync(path.join(dir, "src"), { recursive: true });
			writeFileSync(
				path.join(dir, "src", "index.ts"),
				validPluginSource("source-plugin"),
			);

			const svc = new AppWorkerHostService(
				makeRegistryRuntime({
					slug: "source-plugin",
					directory: dir,
					isolation: "worker",
				}),
			);
			const outcome = await svc.startForRegisteredApp("source-plugin");
			await svc.stop();
			rmSync(dir, { recursive: true, force: true });

			expect(outcome.ok).toBe(true);
		});

		it("reports a missing declared worker artifact when no source fallback exists", async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "app-missing-worker-"));
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "missing-worker", main: "./dist/index.js" }),
			);
			const svc = new AppWorkerHostService(
				makeRegistryRuntime({
					slug: "missing-worker",
					directory: dir,
					isolation: "worker",
					worker: { entry: "dist/index.js" },
				}),
			);
			const outcome = await svc.startForRegisteredApp("missing-worker");
			rmSync(dir, { recursive: true, force: true });

			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.kind).toBe("error");
			expect(outcome.reason).toContain("Declared worker entry is missing");
		});

		it("keeps the conventional source fallback for legacy packages with no entry", async () => {
			const dir = mkdtempSync(path.join(tmpdir(), "app-legacy-worker-"));
			writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "legacy-worker" }),
			);
			mkdirSync(path.join(dir, "src"), { recursive: true });
			writeFileSync(
				path.join(dir, "src", "index.ts"),
				validPluginSource("legacy-worker"),
			);
			const svc = new AppWorkerHostService(
				makeRegistryRuntime({
					slug: "legacy-worker",
					directory: dir,
					isolation: "worker",
				}),
			);
			const outcome = await svc.startForRegisteredApp("legacy-worker");
			await svc.stop();
			rmSync(dir, { recursive: true, force: true });

			expect(outcome.ok).toBe(true);
		});
	});
});
