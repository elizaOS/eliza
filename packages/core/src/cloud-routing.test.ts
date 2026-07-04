/**
 * Covers `isCloudConnected` and `resolveCloudRoute` — the gate and resolver
 * behind the three inference deployment modes documented below — over a
 * synthetic `getSetting` map rather than a live runtime.
 */
import { describe, expect, it } from "vitest";

import {
	type CloudRuntimeSettings,
	isCloudConnected,
	type RouteSpec,
	resolveCloudRoute,
} from "./cloud-routing";

/**
 * Inference routing is what distinguishes the three deployment modes:
 *
 *   - "local-key"   → a local provider key is set; talk to the upstream directly.
 *   - "cloud-proxy" → no local key but Eliza Cloud is connected; route inference
 *                     through the cloud proxy. THIS is "local runtime + cloud
 *                     inference" (and the cloud-hosted agent's own model calls).
 *   - "disabled"    → neither; the agent falls back to on-device/local inference
 *                     (action-model-routing's LOCAL → TEXT_SMALL → TEXT_LARGE
 *                     chain). THIS is "all-local".
 *
 * These branches must stay mutually exclusive and deterministic, so a misread
 * setting can never silently send a local-only user's prompts to the cloud (or
 * strand a cloud user on a missing local key).
 */

function settings(
	map: Record<string, string | boolean | number>,
): CloudRuntimeSettings {
	return {
		getSetting(key: string) {
			return key in map ? map[key] : undefined;
		},
	};
}

const SPEC: RouteSpec = {
	service: "openai",
	localKeySetting: "OPENAI_API_KEY",
	upstreamBaseUrl: "https://api.openai.com/v1/",
	localKeyAuth: { kind: "bearer" },
};

describe("isCloudConnected — cloud-inference gate", () => {
	it("requires BOTH a non-empty api key AND an enabled flag", () => {
		expect(
			isCloudConnected(
				settings({ ELIZAOS_CLOUD_API_KEY: "k", ELIZAOS_CLOUD_ENABLED: true }),
			),
		).toBe(true);
		expect(
			isCloudConnected(
				settings({ ELIZAOS_CLOUD_API_KEY: "k", ELIZAOS_CLOUD_ENABLED: "true" }),
			),
		).toBe(true);
		expect(
			isCloudConnected(
				settings({ ELIZAOS_CLOUD_API_KEY: "k", ELIZAOS_CLOUD_ENABLED: "1" }),
			),
		).toBe(true);
	});

	it("is false when the key is missing/empty or the flag is off", () => {
		expect(isCloudConnected(settings({ ELIZAOS_CLOUD_ENABLED: true }))).toBe(
			false,
		);
		expect(
			isCloudConnected(
				settings({ ELIZAOS_CLOUD_API_KEY: "  ", ELIZAOS_CLOUD_ENABLED: true }),
			),
		).toBe(false);
		expect(
			isCloudConnected(
				settings({
					ELIZAOS_CLOUD_API_KEY: "k",
					ELIZAOS_CLOUD_ENABLED: "false",
				}),
			),
		).toBe(false);
		expect(isCloudConnected(settings({ ELIZAOS_CLOUD_API_KEY: "k" }))).toBe(
			false,
		);
	});
});

describe("resolveCloudRoute — the three modes", () => {
	it("local-key: a local provider key talks to the upstream directly", () => {
		const route = resolveCloudRoute(
			settings({ OPENAI_API_KEY: "sk-local" }),
			SPEC,
		);
		expect(route.source).toBe("local-key");
		if (route.source !== "local-key") throw new Error("unreachable");
		expect(route.baseUrl).toBe("https://api.openai.com/v1");
		expect(route.headers.Authorization).toBe("Bearer sk-local");
	});

	it("cloud-proxy: no local key + cloud connected routes inference through the cloud", () => {
		const route = resolveCloudRoute(
			settings({
				ELIZAOS_CLOUD_API_KEY: "cloud-key",
				ELIZAOS_CLOUD_ENABLED: true,
			}),
			SPEC,
		);
		expect(route.source).toBe("cloud-proxy");
		if (route.source !== "cloud-proxy") throw new Error("unreachable");
		expect(route.baseUrl).toBe("https://elizacloud.ai/api/v1/apis/openai");
		expect(route.headers.Authorization).toBe("Bearer cloud-key");
	});

	it("cloud-proxy honors a custom cloud base url", () => {
		const route = resolveCloudRoute(
			settings({
				ELIZAOS_CLOUD_API_KEY: "cloud-key",
				ELIZAOS_CLOUD_ENABLED: true,
				ELIZAOS_CLOUD_BASE_URL: "https://stage.elizacloud.ai/api/v1/",
			}),
			SPEC,
		);
		expect(route.source).toBe("cloud-proxy");
		if (route.source !== "cloud-proxy") throw new Error("unreachable");
		expect(route.baseUrl).toBe(
			"https://stage.elizacloud.ai/api/v1/apis/openai",
		);
	});

	it("disabled: no local key and cloud not connected → fall back to local inference", () => {
		const route = resolveCloudRoute(settings({}), SPEC);
		expect(route.source).toBe("disabled");
	});

	it("local key ALWAYS wins when both a local key and cloud are present", () => {
		const route = resolveCloudRoute(
			settings({
				OPENAI_API_KEY: "sk-local",
				ELIZAOS_CLOUD_API_KEY: "cloud-key",
				ELIZAOS_CLOUD_ENABLED: true,
			}),
			SPEC,
		);
		expect(route.source).toBe("local-key");
	});
});
