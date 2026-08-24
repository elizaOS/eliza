/**
 * Unit tests for the features/oauth public barrel (index.ts) — the eager
 * bundle-safety anchor that keeps the feature in mobile bundles, the
 * composition of the five atomic actions into oauthPlugin, both init()
 * branches (in-process bus registration vs. existing cloud bus), and the
 * OAuth delivery-target ordering contract. Real modules only; the runtime is
 * a minimal recording stub and there is no network or HTTP server.
 */
import { describe, expect, test, vi } from "vitest";
import type { IAgentRuntime } from "../../types/index.ts";
import * as OAuthFeature from "./index.ts";
import {
	awaitOAuthCallbackAction,
	bindOAuthCredentialAction,
	createOAuthIntentAction,
	deliverOAuthLinkAction,
	eligibleOAuthDeliveryTargets,
	LocalOAuthCallbackBus,
	oauthPlugin,
	revokeOAuthCredentialAction,
} from "./index.ts";

const ATOMIC_ACTIONS = [
	awaitOAuthCallbackAction,
	bindOAuthCredentialAction,
	createOAuthIntentAction,
	deliverOAuthLinkAction,
	revokeOAuthCredentialAction,
];

function makeRuntime(cloudBus?: unknown): IAgentRuntime & {
	getService: ReturnType<typeof vi.fn>;
	registerService: ReturnType<typeof vi.fn>;
} {
	return {
		getService: vi.fn(() => cloudBus),
		registerService: vi.fn(async () => {}),
	} as unknown as IAgentRuntime & {
		getService: ReturnType<typeof vi.fn>;
		registerService: ReturnType<typeof vi.fn>;
	};
}

describe("features/oauth barrel (index.ts)", () => {
	test("eagerly anchors the composed plugin on globalThis for mobile-bundle retention", () => {
		const anchored = (globalThis as Record<string, unknown>)
			.__bundle_safety_FEATURES_OAUTH_INDEX__;
		expect(Array.isArray(anchored)).toBe(true);
		expect(anchored).toHaveLength(1);
		expect((anchored as unknown[])[0]).toBe(oauthPlugin);
	});

	test("exposes all five atomic actions as live dispatchable handlers", () => {
		for (const action of ATOMIC_ACTIONS) {
			expect(action).toBeTypeOf("object");
			expect(action.name).toBeTypeOf("string");
			expect(action.name.length).toBeGreaterThan(0);
			expect(action.validate).toBeTypeOf("function");
			expect(action.handler).toBeTypeOf("function");
		}
	});

	test("composes exactly the five exported action objects into the plugin", () => {
		const exported = new Set(ATOMIC_ACTIONS);
		expect(oauthPlugin.actions).toHaveLength(5);
		for (const action of oauthPlugin.actions ?? []) {
			expect(exported.has(action)).toBe(true);
		}
	});

	test("default export is the same plugin object as the named export", () => {
		expect(OAuthFeature.default).toBe(OAuthFeature.oauthPlugin);
	});

	test("ships the public local callback route", () => {
		const routes = oauthPlugin.routes ?? [];
		expect(routes).toHaveLength(1);
		expect(routes[0].type).toBe("POST");
		expect(routes[0].path).toBe("/api/oauth/callback");
		expect(routes[0].public).toBe(true);
	});

	test("init registers LocalOAuthCallbackBus when no cloud bus client is present", async () => {
		const runtime = makeRuntime(undefined);
		await oauthPlugin.init({}, runtime);
		expect(runtime.getService).toHaveBeenCalledWith("OAuthCallbackBusClient");
		expect(runtime.registerService).toHaveBeenCalledTimes(1);
		expect(runtime.registerService).toHaveBeenCalledWith(LocalOAuthCallbackBus);
	});

	test("init keeps an existing cloud bus client and skips local registration", async () => {
		const runtime = makeRuntime({ waitFor: async () => ({}) });
		await oauthPlugin.init({}, runtime);
		expect(runtime.registerService).not.toHaveBeenCalled();
	});

	test("eligibleOAuthDeliveryTargets prefers direct/authenticated channels before public_link", () => {
		expect(eligibleOAuthDeliveryTargets()).toEqual([
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
			"public_link",
		]);
	});

	test("returns a fresh array so callers can mutate their copy safely", () => {
		const first = eligibleOAuthDeliveryTargets();
		const second = eligibleOAuthDeliveryTargets();
		expect(first).not.toBe(second);
		first.reverse();
		expect(second[0]).toBe("dm");
	});
});
