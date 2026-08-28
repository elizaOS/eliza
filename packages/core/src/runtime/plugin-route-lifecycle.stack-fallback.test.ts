/**
 * Regression test for the browser/constrained-runtime fallback path of plugin
 * route ownership.
 *
 * `pluginRegistrationContext` uses `AsyncLocalStorage` on Node and a
 * synchronous stack storage everywhere else. The stack storage cannot
 * propagate context across an `await` inside `registerPlugin`, so routes that
 * a plugin registers after its asynchronous `init()` resolves would be absent
 * from its ownership record without the route-diff fallback in
 * `trackRegisteredPluginRef` — leaving them orphaned on unload/reload/rollback.
 *
 * This file hides `process.versions.node` *after* pre-initializing undici (so
 * the lazy-loaded fetch machinery still has a version string to parse) and
 * then dynamically imports the runtime chain, which makes
 * `createAsyncContextStorage` select the stack implementation — the same
 * branch constrained runtimes take. The real `AgentRuntime.initialize()` /
 * `unloadPlugin()` path is then exercised end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Character, Plugin } from "../types";

const originalNodeVersion = process.versions.node;

beforeAll(async () => {
	// undici reads `process.versions.node` once, at module initialization, on
	// the first fetch call. Warm it while the version string is still present
	// so the runtime chain below can keep using fetch/URL machinery after we
	// hide the version.
	await fetch("http://127.0.0.1:1/").catch(() => {});
	// Force the non-Node branch of `createAsyncContextStorage` for the
	// dynamic import below. Restored in `afterAll`.
	delete (process.versions as { node?: string }).node;
});

afterAll(() => {
	(process.versions as { node?: string }).node = originalNodeVersion;
});

describe("plugin route lifecycle (stack context fallback)", () => {
	it("still owns routes registered after async init when the async context cannot propagate", async () => {
		const { AgentRuntime } = await import("../runtime");

		const pluginA: Plugin = {
			name: "plugin-a",
			description: "Registers one route after asynchronous initialization",
			init: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			},
			routes: [
				{
					type: "GET",
					path: "/a",
					public: false,
					handler: async () => {},
				} as never,
			],
		};
		const pluginB: Plugin = {
			name: "plugin-b",
			description: "Registers one route without asynchronous initialization",
			routes: [
				{
					type: "GET",
					path: "/b",
					public: false,
					handler: async () => {},
				} as never,
			],
		};
		const runtime = new AgentRuntime({
			character: { name: "Route ownership (stack fallback)" } as Character,
			plugins: [pluginA, pluginB],
			logLevel: "fatal",
		});

		await runtime.initialize({ allowNoDatabase: true });

		expect(
			runtime.getPluginOwnership("plugin-a")?.routes.map((route) => route.path),
		).toEqual(["/plugin-a/a"]);
		expect(
			runtime.getPluginOwnership("plugin-b")?.routes.map((route) => route.path),
		).toEqual(["/plugin-b/b"]);

		await runtime.unloadPlugin("plugin-a");

		// The peer plugin's route must survive the slow plugin's teardown.
		expect(runtime.routes.map((route) => route.path)).toContain("/plugin-b/b");
	});
});
