/**
 * @module plugin-app-control/services/__tests__/app-permissions-e2e
 *
 * Phase 2.5 end-to-end test for the app-permissions sandbox flow.
 * Wires AppRegistryService + AppWorkerHostService together via a
 * minimal runtime stub and walks the full registration -> auto-spawn
 * -> grant -> invoke -> stop path.
 *
 * Path under test:
 *
 *   1. Register an app with isolation:"worker", net.outbound declared.
 *   2. Auto-spawn fires from registry.register() and the host service
 *      brings up a Bun worker with the fixture plugin.
 *   3. Grant the "net" namespace via setGrantedNamespaces().
 *   4. Invoke a fixture action through the worker host bridge.
 *   5. Cleanly tear down both services.
 *
 * This is the slice that proves the contract layers from Phase 1 +
 * Phase 2.1-2.4 actually compose into a working pipeline.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRegistryService } from "../app-registry-service.js";
import { AppWorkerHostService } from "../app-worker-host-service.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PLUGIN_PATH = path.resolve(
	path.dirname(__filename),
	"../../../test/fixtures/sandbox-plugin/plugin.ts",
);

interface TestEnv {
	stateDir: string;
	previousStateDir: string | undefined;
	previousNamespace: string | undefined;
	httpServer: http.Server;
	httpServerUrl: string;
}

async function makeTestEnv(): Promise<TestEnv> {
	const stateDir = mkdtempSync(path.join(tmpdir(), "app-perms-e2e-"));
	const previousStateDir = process.env.ELIZA_STATE_DIR;
	const previousNamespace = process.env.ELIZA_NAMESPACE;
	process.env.ELIZA_STATE_DIR = stateDir;
	delete process.env.ELIZA_NAMESPACE;

	const httpServer = http.createServer((_req, res) => {
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
	return {
		stateDir,
		previousStateDir,
		previousNamespace,
		httpServer,
		httpServerUrl: `http://127.0.0.1:${addr.port}/`,
	};
}

async function teardownTestEnv(env: TestEnv): Promise<void> {
	await new Promise<void>((resolve) => env.httpServer.close(() => resolve()));
	rmSync(env.stateDir, { recursive: true, force: true });
	if (env.previousStateDir === undefined) {
		delete process.env.ELIZA_STATE_DIR;
	} else {
		process.env.ELIZA_STATE_DIR = env.previousStateDir;
	}
	if (env.previousNamespace === undefined) {
		delete process.env.ELIZA_NAMESPACE;
	} else {
		process.env.ELIZA_NAMESPACE = env.previousNamespace;
	}
}

/**
 * Minimal runtime that exposes a service-registry getService() so
 * AppRegistryService.register() can find AppWorkerHostService for
 * auto-spawn. Also gives AppWorkerHostService.startForRegisteredApp()
 * its way back to the registry.
 */
function makeRuntime(services: Map<string, unknown>): IAgentRuntime {
	return {
		getService: (type: string) => services.get(type) ?? null,
	} as unknown as IAgentRuntime;
}

describe("Phase 2.5 — registry → auto-spawn → invoke end-to-end", () => {
	let env: TestEnv;
	let registry: AppRegistryService;
	let host: AppWorkerHostService;

	beforeEach(async () => {
		env = await makeTestEnv();
		// Tests below explicitly call host.spawn() with a known
		// pluginEntryPath; we deliberately omit the host service from
		// the registry's runtime services map so auto-spawn doesn't
		// fire (auto-spawn uses the entry directory's package.json
		// which the fixture doesn't ship).
		const services = new Map<string, unknown>();
		const runtime = makeRuntime(services);
		registry = new AppRegistryService(runtime);
		host = new AppWorkerHostService(runtime);
		services.set("app-registry", registry);
	});

	afterEach(async () => {
		await host.stop();
		await teardownTestEnv(env);
	});

	function makePackageDir(slug: string): string {
		const dir = path.join(env.stateDir, "packages", slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: `@example/${slug}`,
				main: path.relative(dir, FIXTURE_PLUGIN_PATH),
			}),
		);
		return dir;
	}

	it("register() with isolation:'worker' is a no-op when the host service is not on the runtime", async () => {
		// Sanity check: the registry's auto-spawn lookup short-circuits
		// when the host service isn't registered. The register() call
		// must not throw and the host service must have zero workers.
		await registry.register(
			{
				slug: "e2e-no-host",
				canonicalName: "@example/app-e2e-no-host",
				aliases: [],
				directory: path.dirname(FIXTURE_PLUGIN_PATH),
				displayName: "E2E No-Host",
				isolation: "worker",
			},
			{ trust: "external" },
		);
		expect(host.list()).toEqual([]);
	});

	it("auto-spawns the worker when the host service IS on the runtime (best-effort)", async () => {
		const services = new Map<string, unknown>();
		const runtime = makeRuntime(services);
		const localRegistry = new AppRegistryService(runtime);
		const localHost = new AppWorkerHostService(runtime);
		services.set("app-registry", localRegistry);
		services.set("app-worker-host", localHost);
		try {
			const directory = makePackageDir("app-e2e-autospawn");
			await localRegistry.register(
				{
					slug: "e2e-autospawn",
					canonicalName: "@example/app-e2e-autospawn",
					aliases: [],
					directory,
					displayName: "E2E Auto-Spawn",
					isolation: "worker",
				},
				{ trust: "external" },
			);
			const slugs = localHost.list().map((s) => s.slug);
			expect(slugs).toContain("e2e-autospawn");
			const reply = await localHost.invoke("e2e-autospawn", "invokeAction", {
				actionName: "ECHO",
				content: { ok: true },
			});
			expect(reply.ok).toBe(true);
		} finally {
			await localHost.stop();
		}
	});

	it("bootstraps persisted worker apps when AppWorkerHostService starts", async () => {
		const services = new Map<string, unknown>();
		const runtime = makeRuntime(services);
		const localRegistry = new AppRegistryService(runtime);
		services.set("app-registry", localRegistry);
		const directory = makePackageDir("app-e2e-bootstrap");
		await localRegistry.register(
			{
				slug: "e2e-bootstrap",
				canonicalName: "@example/app-e2e-bootstrap",
				aliases: [],
				directory,
				displayName: "E2E Bootstrap",
				isolation: "worker",
			},
			{ trust: "external" },
		);

		const localHost = await AppWorkerHostService.start(runtime);
		try {
			services.set("app-worker-host", localHost);
			expect(localHost.list().map((s) => s.slug)).toContain("e2e-bootstrap");
			const reply = await localHost.invoke("e2e-bootstrap", "invokeAction", {
				actionName: "ECHO",
				content: { bootstrapped: true },
			});
			expect(reply.ok).toBe(true);
		} finally {
			await localHost.stop();
		}
	});

	it("stops and restarts worker-isolated apps when grants change", async () => {
		const calls: string[] = [];
		const services = new Map<string, unknown>();
		const runtime = makeRuntime(services);
		const localRegistry = new AppRegistryService(runtime);
		services.set("app-worker-host", {
			startForRegisteredApp: async (slug: string) => {
				calls.push(`start:${slug}`);
				return { ok: true };
			},
			stopWorker: async (slug: string) => {
				calls.push(`stop:${slug}`);
			},
		});

		await localRegistry.register(
			{
				slug: "e2e-refresh-grants",
				canonicalName: "@example/app-e2e-refresh-grants",
				aliases: [],
				directory: path.dirname(FIXTURE_PLUGIN_PATH),
				displayName: "E2E Refresh Grants",
				isolation: "worker",
				requestedPermissions: { net: { outbound: ["127.0.0.1"] } },
			},
			{ trust: "external" },
		);
		expect(calls).toEqual(["start:e2e-refresh-grants"]);

		await localRegistry.setGrantedNamespaces(
			"e2e-refresh-grants",
			["net"],
			"user",
		);
		expect(calls).toEqual([
			"start:e2e-refresh-grants",
			"stop:e2e-refresh-grants",
			"start:e2e-refresh-grants",
		]);

		await localRegistry.setGrantedNamespaces("e2e-refresh-grants", [], "user");
		expect(calls).toEqual([
			"start:e2e-refresh-grants",
			"stop:e2e-refresh-grants",
			"start:e2e-refresh-grants",
			"stop:e2e-refresh-grants",
		]);
	});

	it("manual spawn with explicit pluginEntryPath + grant + invoke round-trips an action through the worker", async () => {
		await registry.register(
			{
				slug: "e2e-manual",
				canonicalName: "@example/app-e2e-manual",
				aliases: [],
				directory: path.dirname(FIXTURE_PLUGIN_PATH),
				displayName: "E2E Manual",
				isolation: "worker",
				requestedPermissions: { net: { outbound: ["127.0.0.1"] } },
			},
			{ trust: "external" },
		);

		// Grant net via the registry's grant store.
		const grantResult = await registry.setGrantedNamespaces(
			"e2e-manual",
			["net"],
			"user",
		);
		expect(grantResult.ok).toBe(true);

		// Spawn directly with the fixture plugin path so we know the
		// worker has actions loaded.
		const view = await registry.getPermissionsView("e2e-manual");
		expect(view?.grantedNamespaces).toEqual(["net"]);
		await host.spawn({
			slug: "e2e-manual",
			isolation: "worker",
			pluginEntryPath: FIXTURE_PLUGIN_PATH,
			requestedPermissions: view?.requestedPermissions ?? null,
			grantedNamespaces: view?.grantedNamespaces ?? [],
		});

		// Invoke the NET_FETCH action — should succeed because grant
		// includes "net" and the manifest declared 127.0.0.1.
		const reply = await host.invoke<{ status: number }>(
			"e2e-manual",
			"invokeAction",
			{
				actionName: "NET_FETCH",
				content: { url: env.httpServerUrl },
			},
		);
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		expect(reply.result.status).toBe(204);
	});

	it("revoking 'net' before invoke causes the gate to reject", async () => {
		await registry.register(
			{
				slug: "e2e-revoke",
				canonicalName: "@example/app-e2e-revoke",
				aliases: [],
				directory: path.dirname(FIXTURE_PLUGIN_PATH),
				displayName: "E2E Revoke",
				isolation: "worker",
				requestedPermissions: { net: { outbound: ["127.0.0.1"] } },
			},
			{ trust: "external" },
		);
		await registry.setGrantedNamespaces("e2e-revoke", ["net"], "user");
		await registry.setGrantedNamespaces("e2e-revoke", [], "user");
		const view = await registry.getPermissionsView("e2e-revoke");
		expect(view?.grantedNamespaces).toEqual([]);

		await host.spawn({
			slug: "e2e-revoke",
			isolation: "worker",
			pluginEntryPath: FIXTURE_PLUGIN_PATH,
			requestedPermissions: view?.requestedPermissions ?? null,
			grantedNamespaces: view?.grantedNamespaces ?? [],
		});

		const reply = await host.invoke("e2e-revoke", "invokeAction", {
			actionName: "NET_FETCH",
			content: { url: env.httpServerUrl },
		});
		expect(reply.ok).toBe(false);
		if (reply.ok) return;
		expect(reply.reason).toContain("net access not granted");
	});
});
