/**
 * Registration guard for `public: true` routes (#12228 L11). A public route
 * bypasses the central auth gate, so `assertPublicRouteIntent` rejects one that
 * omits `publicReason` and — defense-in-depth — one that uses a write method
 * (POST/PUT/PATCH/DELETE) without declaring `publicWrite` (the out-of-band auth
 * that stands in for the gate). GET/STATIC public reads need no opt-in.
 */

import { describe, expect, it } from "vitest";
import type { Route } from "./plugin";
import { assertPublicRouteIntent } from "./plugin";

const READ_REASON = "Read-only public surface for unauthenticated clients.";
const WRITE_REASON =
	"Inbound webhook POST authenticated by payload signature, not the local gate.";

describe("assertPublicRouteIntent — public read routes", () => {
	it("accepts a public GET route with a publicReason", () => {
		const route: Route = {
			type: "GET",
			path: "/api/plugin/status",
			public: true,
			name: "plugin-status",
			publicReason: READ_REASON,
		};
		expect(() => assertPublicRouteIntent(route)).not.toThrow();
	});

	it("accepts a public STATIC route with a publicReason", () => {
		const route: Route = {
			type: "STATIC",
			path: "/assets/app.js",
			public: true,
			name: "plugin-asset",
			publicReason: READ_REASON,
		};
		expect(() => assertPublicRouteIntent(route)).not.toThrow();
	});

	it("rejects a public route missing publicReason", () => {
		const route = {
			type: "GET",
			path: "/api/plugin/status",
			public: true,
			name: "plugin-status",
		} as unknown as Route;
		expect(() => assertPublicRouteIntent(route)).toThrow(
			/must declare publicReason/,
		);
	});
});

describe("assertPublicRouteIntent — public write routes need publicWrite", () => {
	const writeMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;

	for (const type of writeMethods) {
		it(`rejects a public ${type} route without publicWrite`, () => {
			const route = {
				type,
				path: "/api/plugin/webhook",
				public: true,
				name: "plugin-webhook",
				publicReason: WRITE_REASON,
			} as unknown as Route;
			expect(() => assertPublicRouteIntent(route)).toThrow(
				/must declare publicWrite/,
			);
		});

		it(`accepts a public ${type} route that declares publicWrite`, () => {
			const route: Route = {
				type,
				path: "/api/plugin/webhook",
				public: true,
				name: "plugin-webhook",
				publicReason: WRITE_REASON,
				publicWrite: WRITE_REASON,
			};
			expect(() => assertPublicRouteIntent(route)).not.toThrow();
		});
	}

	it("rejects a public write route whose publicWrite is blank", () => {
		const route = {
			type: "POST",
			path: "/api/plugin/webhook",
			public: true,
			name: "plugin-webhook",
			publicReason: WRITE_REASON,
			publicWrite: "   ",
		} as unknown as Route;
		expect(() => assertPublicRouteIntent(route)).toThrow(
			/must declare publicWrite/,
		);
	});
});

describe("assertPublicRouteIntent — private routes are unaffected", () => {
	it("accepts a private POST route without any public fields", () => {
		const route: Route = {
			type: "POST",
			path: "/api/plugin/mutate",
		};
		expect(() => assertPublicRouteIntent(route)).not.toThrow();
	});

	it("accepts a private GET route", () => {
		const route: Route = { type: "GET", path: "/api/plugin/read" };
		expect(() => assertPublicRouteIntent(route)).not.toThrow();
	});
});
