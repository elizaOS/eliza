/**
 * The app-route plugin registry + its idempotent drain.
 *
 * Both the headless `@elizaos/agent` boot and the `@elizaos/app-core` boot drain
 * this registry onto the same `runtime.routes` in a combined deployment, so the
 * drain MUST be idempotent (dedup by `${type}:${path}`) — otherwise every route
 * the orchestrator/lifeops/workflow plugins register would be mounted twice.
 */

import { describe, expect, it } from "vitest";
import {
	type AppRoutePluginRegistryEntry,
	drainAppRoutePluginLoaders,
	isOptionalAppRoutePluginUnavailableError,
	listAppRoutePluginLoaders,
	OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME,
	OptionalAppRoutePluginUnavailableError,
	registerAppRoutePluginLoader,
} from "./app-route-plugin-registry";
import type { Plugin, Route } from "./types/plugin";

function plugin(name: string, routes: Route[]): Plugin {
	return { name, description: `${name} test plugin`, routes };
}

function route(type: Route["type"], path: string): Route {
	return { type, path };
}

function loader(
	id: string,
	load: AppRoutePluginRegistryEntry["load"],
): AppRoutePluginRegistryEntry {
	return { id, load };
}

describe("drainAppRoutePluginLoaders", () => {
	it("drains routes onto the target and normalizes a missing leading slash", async () => {
		const target: { routes: Route[] } = { routes: [] };
		await drainAppRoutePluginLoaders(target, [
			loader("a", () =>
				plugin("a", [route("GET", "/api/a"), route("POST", "api/b")]),
			),
		]);
		expect(target.routes).toEqual([
			{ type: "GET", path: "/api/a" },
			{ type: "POST", path: "/api/b" },
		]);
	});

	it("is idempotent — a second drain of the same loaders adds nothing", async () => {
		const target: { routes: Route[] } = { routes: [] };
		const loaders = [
			loader("a", () => plugin("a", [route("GET", "/api/orchestrator/tasks")])),
		];
		await drainAppRoutePluginLoaders(target, loaders);
		await drainAppRoutePluginLoaders(target, loaders);
		expect(target.routes).toHaveLength(1);
	});

	it("dedups against routes already present on the target", async () => {
		const target: { routes: Route[] } = {
			routes: [{ type: "GET", path: "/api/a" }],
		};
		await drainAppRoutePluginLoaders(target, [
			loader("a", () =>
				plugin("a", [route("GET", "/api/a"), route("GET", "/api/c")]),
			),
		]);
		expect(target.routes).toEqual([
			{ type: "GET", path: "/api/a" },
			{ type: "GET", path: "/api/c" },
		]);
	});

	it("does not dedup distinct methods on the same path", async () => {
		const target: { routes: Route[] } = { routes: [] };
		await drainAppRoutePluginLoaders(target, [
			loader("a", () =>
				plugin("a", [route("GET", "/api/x"), route("POST", "/api/x")]),
			),
		]);
		expect(target.routes).toHaveLength(2);
	});

	it("isolates an optional-unavailable loader (core error class) and still drains the rest", async () => {
		const target: { routes: Route[] } = { routes: [] };
		await drainAppRoutePluginLoaders(target, [
			loader("optional", () => {
				throw new OptionalAppRoutePluginUnavailableError(
					"@elizaos/plugin-absent",
				);
			}),
			loader("ok", () => plugin("ok", [route("GET", "/api/ok")])),
		]);
		expect(target.routes).toEqual([{ type: "GET", path: "/api/ok" }]);
	});

	it("recognizes the optional-unavailable signal by name across bundles (no instanceof)", async () => {
		// A duplicate @elizaos/core bundle produces a distinct class identity, so
		// the host may throw an error that is only name-equal, not instanceof-equal.
		const target: { routes: Route[] } = { routes: [] };
		const foreign = new Error("nope");
		foreign.name = OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME;
		await drainAppRoutePluginLoaders(target, [
			loader("optional", () => {
				throw foreign;
			}),
			loader("ok", () => plugin("ok", [route("GET", "/api/ok")])),
		]);
		expect(target.routes).toEqual([{ type: "GET", path: "/api/ok" }]);
	});

	it("isolates a hard-failing loader and still drains the rest", async () => {
		const target: { routes: Route[] } = { routes: [] };
		await drainAppRoutePluginLoaders(target, [
			loader("broken", () => {
				throw new Error("boom");
			}),
			loader("ok", () => plugin("ok", [route("GET", "/api/ok")])),
		]);
		expect(target.routes).toEqual([{ type: "GET", path: "/api/ok" }]);
	});

	it("is a no-op for an empty loader set", async () => {
		const target: { routes: Route[] } = {
			routes: [{ type: "GET", path: "/keep" }],
		};
		await drainAppRoutePluginLoaders(target, []);
		expect(target.routes).toEqual([{ type: "GET", path: "/keep" }]);
	});

	it("defaults to the global registry when no loaders are passed", async () => {
		const id = "test-registry-roundtrip-loader";
		registerAppRoutePluginLoader(id, () =>
			plugin("registered", [route("GET", "/api/registered/from-global")]),
		);
		expect(listAppRoutePluginLoaders().some((l) => l.id === id)).toBe(true);
		const target: { routes: Route[] } = { routes: [] };
		await drainAppRoutePluginLoaders(target);
		expect(
			target.routes.some((r) => r.path === "/api/registered/from-global"),
		).toBe(true);
	});
});

describe("OptionalAppRoutePluginUnavailableError", () => {
	it("carries the canonical name + specifier and is recognized by the guard", () => {
		const err = new OptionalAppRoutePluginUnavailableError(
			"@elizaos/plugin-absent",
			new Error("cause"),
		);
		expect(err.name).toBe(OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME);
		expect(err.specifier).toBe("@elizaos/plugin-absent");
		expect(err.cause).toBeInstanceOf(Error);
		expect(isOptionalAppRoutePluginUnavailableError(err)).toBe(true);
	});

	it("guard rejects unrelated errors and non-errors", () => {
		expect(isOptionalAppRoutePluginUnavailableError(new Error("boom"))).toBe(
			false,
		);
		expect(isOptionalAppRoutePluginUnavailableError("string")).toBe(false);
		expect(isOptionalAppRoutePluginUnavailableError(null)).toBe(false);
	});
});
