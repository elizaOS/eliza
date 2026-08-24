/**
 * Unit tests for the OAuth atomic-action runtime surface in types.ts — the
 * accepted-provider policy lists, the stable service-name keys that actions
 * and adapters resolve through `runtime.getService(...)`, and the
 * eligibleOAuthDeliveryTargets allowlist consumed by CREATE_OAUTH_INTENT and
 * DELIVER_OAUTH_LINK to decide where an authorization link may be delivered.
 * Deterministic pure-value harness driving the real module; no mocks, no I/O.
 */
import { describe, expect, test } from "vitest";
import { LocalOAuthCallbackBus } from "./local-callback-bus.ts";
import {
	CONNECTOR_NATIVE_OAUTH_PROVIDERS,
	eligibleOAuthDeliveryTargets,
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	OAUTH_INTENTS_CLIENT_SERVICE,
	OAUTH_PROVIDERS,
} from "./types.ts";

describe("eligibleOAuthDeliveryTargets", () => {
	test("offers every delivery channel an OAuth link may use", () => {
		const targets = eligibleOAuthDeliveryTargets();
		expect(targets.length).toBeGreaterThan(0);
		expect(new Set(targets).size).toBe(targets.length);
		expect(targets).toContain("dm");
		expect(targets).toContain("owner_app_inline");
		expect(targets).toContain("cloud_authenticated_link");
		expect(targets).toContain("tunnel_authenticated_link");
		expect(targets).toContain("public_link");
	});

	test("gates delivery by membership, so unknown targets are ineligible", () => {
		const targets = eligibleOAuthDeliveryTargets();
		expect(targets.includes("dm")).toBe(true);
		expect(targets.includes("carrier_pigeon")).toBe(false);
		expect(targets.includes("")).toBe(false);
	});

	test("returns a fresh array on every call so callers cannot corrupt policy", () => {
		const first = eligibleOAuthDeliveryTargets();
		const second = eligibleOAuthDeliveryTargets();
		expect(first).not.toBe(second);

		first.length = 0;
		expect(eligibleOAuthDeliveryTargets().length).toBeGreaterThan(0);
	});
});

describe("OAuth provider policy lists", () => {
	test("accepts each documented provider exactly once", () => {
		expect(OAUTH_PROVIDERS).toHaveLength(9);
		expect(new Set(OAUTH_PROVIDERS).size).toBe(OAUTH_PROVIDERS.length);
		for (const provider of [
			"google",
			"discord",
			"github",
			"notion",
			"slack",
			"linkedin",
			"linear",
			"shopify",
			"calendly",
		]) {
			expect(OAUTH_PROVIDERS).toContain(provider);
		}
	});

	test("connector-native providers stay inside the accepted provider list", () => {
		expect(CONNECTOR_NATIVE_OAUTH_PROVIDERS.length).toBeGreaterThan(0);
		for (const provider of CONNECTOR_NATIVE_OAUTH_PROVIDERS) {
			expect(OAUTH_PROVIDERS).toContain(provider);
		}
	});

	test("exempts discord from cloud alignment but not google", () => {
		expect(CONNECTOR_NATIVE_OAUTH_PROVIDERS).toEqual(["discord"]);
		expect(CONNECTOR_NATIVE_OAUTH_PROVIDERS).not.toContain("google");
	});
});

describe("OAuth service name keys", () => {
	test("intents client and callback bus resolve under distinct stable keys", () => {
		expect(OAUTH_INTENTS_CLIENT_SERVICE).toBe("OAuthIntentsClient");
		expect(OAUTH_CALLBACK_BUS_CLIENT_SERVICE).toBe("OAuthCallbackBusClient");
		expect(OAUTH_INTENTS_CLIENT_SERVICE).not.toBe(
			OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
		);
	});

	test("the callback bus registers under the key awaiting actions use", () => {
		expect(LocalOAuthCallbackBus.serviceType).toBe(
			OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
		);
	});
});
