/**
 * Covers the model-gateway resolution layer — `resolveModelGateway` /
 * `applyModelGateway`, the canonical `ELIZA_MODEL_GATEWAY_*` env var names, the
 * credential scrubber, and strict fail-closed mode — over a synthetic getSetting
 * record, so no process.env or live provider is touched.
 */
import { describe, expect, it } from "vitest";
import {
	applyModelGateway,
	ELIZA_MODEL_GATEWAY_STRICT,
	ELIZA_MODEL_GATEWAY_TOKEN,
	ELIZA_MODEL_GATEWAY_URL,
	MODEL_GATEWAY_STRICT_KEY,
	MODEL_GATEWAY_TOKEN_KEY,
	MODEL_GATEWAY_URL_KEY,
	ModelGatewayStrictError,
	resolveModelGateway,
} from "./model-gateway.ts";

/**
 * Build a getSetting accessor over a plain record so tests never touch
 * process.env. resolveModelGateway only cares about the string values it reads
 * back, matching the runtime getSetting contract.
 */
function settingsFrom(
	values: Record<string, string | undefined>,
): (key: string) => string | undefined {
	return (key: string) => values[key];
}

describe("canonical env var names (shared contract with E2 sibling #11651)", () => {
	// The env var NAMES are the cross-layer contract shared with
	// plugins/plugin-agent-orchestrator/src/services/model-gateway.ts. They must
	// stay exactly these strings so both the core-runtime layer (here) and the
	// spawned-sub-agent layer resolve the same variables.
	it("pins the canonical env var strings", () => {
		expect(MODEL_GATEWAY_URL_KEY).toBe("ELIZA_MODEL_GATEWAY_URL");
		expect(MODEL_GATEWAY_TOKEN_KEY).toBe("ELIZA_MODEL_GATEWAY_TOKEN");
		expect(MODEL_GATEWAY_STRICT_KEY).toBe("ELIZA_MODEL_GATEWAY_STRICT");
	});

	it("keeps the backwards-compatible aliases pointing at the canonical names", () => {
		expect(ELIZA_MODEL_GATEWAY_URL).toBe(MODEL_GATEWAY_URL_KEY);
		expect(ELIZA_MODEL_GATEWAY_TOKEN).toBe(MODEL_GATEWAY_TOKEN_KEY);
		expect(ELIZA_MODEL_GATEWAY_STRICT).toBe(MODEL_GATEWAY_STRICT_KEY);
	});
});

describe("resolveModelGateway", () => {
	it("is disabled and inert when no gateway URL is set", () => {
		const resolution = resolveModelGateway(settingsFrom({}));
		expect(resolution.enabled).toBe(false);
		expect(resolution.strict).toBe(false);
		expect(resolution.baseURL).toBeUndefined();
		expect(resolution.apiKey).toBeUndefined();
	});

	it("treats a blank/whitespace gateway URL as unset (disabled)", () => {
		const resolution = resolveModelGateway(
			settingsFrom({ [ELIZA_MODEL_GATEWAY_URL]: "   " }),
		);
		expect(resolution.enabled).toBe(false);
		expect(resolution.baseURL).toBeUndefined();
	});

	describe("gateway URL / token precedence", () => {
		it("makes the gateway URL the effective base URL and gateway token the effective api key", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
					[ELIZA_MODEL_GATEWAY_TOKEN]: "agent-scoped-token",
				}),
			);
			expect(resolution.enabled).toBe(true);
			expect(resolution.baseURL).toBe("https://broker.example/v1");
			expect(resolution.apiKey).toBe("agent-scoped-token");
		});

		it("trims surrounding whitespace on URL and token", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					[ELIZA_MODEL_GATEWAY_URL]: "  https://broker.example/v1  ",
					[ELIZA_MODEL_GATEWAY_TOKEN]: "  tok  ",
				}),
			);
			expect(resolution.baseURL).toBe("https://broker.example/v1");
			expect(resolution.apiKey).toBe("tok");
		});

		it("overrides raw OPENAI_BASE_URL / OPENAI_API_KEY at the same resolution layer", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					OPENAI_BASE_URL: "https://api.openai.com/v1",
					OPENAI_API_KEY: "sk-raw-should-not-win",
					[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
					[ELIZA_MODEL_GATEWAY_TOKEN]: "gw-token",
				}),
			);
			const applied = applyModelGateway(
				{
					baseURL: "https://api.openai.com/v1",
					apiKey: "sk-raw-should-not-win",
				},
				resolution,
			);
			expect(applied.baseURL).toBe("https://broker.example/v1");
			expect(applied.apiKey).toBe("gw-token");
		});

		it("gateway with no token yields an undefined effective api key (gateway may inject upstream itself)", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
				}),
			);
			expect(resolution.enabled).toBe(true);
			expect(resolution.apiKey).toBeUndefined();
		});
	});

	describe("strict mode fail-closed", () => {
		it("throws ModelGatewayStrictError naming the offending var when a raw provider key is present", () => {
			const call = () =>
				resolveModelGateway(
					settingsFrom({
						[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
						[ELIZA_MODEL_GATEWAY_STRICT]: "1",
						OPENAI_API_KEY: "sk-leaked",
					}),
				);
			expect(call).toThrow(ModelGatewayStrictError);
			expect(call).toThrow(/OPENAI_API_KEY/);
			expect(call).toThrow(new RegExp(ELIZA_MODEL_GATEWAY_STRICT));
		});

		it("names every offending raw provider key", () => {
			let error: ModelGatewayStrictError | undefined;
			try {
				resolveModelGateway(
					settingsFrom({
						[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
						[ELIZA_MODEL_GATEWAY_STRICT]: "true",
						OPENAI_API_KEY: "sk-leaked",
						ANTHROPIC_API_KEY: "sk-ant-leaked",
					}),
				);
			} catch (caught) {
				error = caught as ModelGatewayStrictError;
			}
			expect(error).toBeInstanceOf(ModelGatewayStrictError);
			expect(error?.offendingVars).toEqual([
				"OPENAI_API_KEY",
				"ANTHROPIC_API_KEY",
			]);
			expect(error?.message).toContain("OPENAI_API_KEY");
			expect(error?.message).toContain("ANTHROPIC_API_KEY");
		});

		it("does not throw in strict mode when no raw provider keys are present", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
					[ELIZA_MODEL_GATEWAY_TOKEN]: "gw-token",
					[ELIZA_MODEL_GATEWAY_STRICT]: "1",
				}),
			);
			expect(resolution.enabled).toBe(true);
			expect(resolution.strict).toBe(true);
			expect(resolution.baseURL).toBe("https://broker.example/v1");
			expect(resolution.apiKey).toBe("gw-token");
		});

		it("does NOT fail closed when strict mode is on but gateway mode is off", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					[ELIZA_MODEL_GATEWAY_STRICT]: "1",
					OPENAI_API_KEY: "sk-raw",
				}),
			);
			// No gateway URL => not gateway mode => strict has nothing to enforce.
			expect(resolution.enabled).toBe(false);
			expect(resolution.strict).toBe(true);
		});

		it("non-strict: gateway silently wins even when a raw provider key is present (no throw)", () => {
			const resolution = resolveModelGateway(
				settingsFrom({
					[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
					[ELIZA_MODEL_GATEWAY_TOKEN]: "gw-token",
					OPENAI_API_KEY: "sk-raw-still-present",
				}),
			);
			expect(resolution.enabled).toBe(true);
			expect(resolution.strict).toBe(false);
			expect(resolution.baseURL).toBe("https://broker.example/v1");
			expect(resolution.apiKey).toBe("gw-token");
		});
	});
});

describe("applyModelGateway (scrubber)", () => {
	it("passes raw creds through unchanged when gateway mode is off", () => {
		const resolution = resolveModelGateway(settingsFrom({}));
		const applied = applyModelGateway(
			{ baseURL: "https://api.openai.com/v1", apiKey: "sk-raw" },
			resolution,
		);
		expect(applied.baseURL).toBe("https://api.openai.com/v1");
		expect(applied.apiKey).toBe("sk-raw");
	});

	it("SCRUBS the raw provider key when gateway mode is on (resolved config carries no raw key material)", () => {
		const resolution = resolveModelGateway(
			settingsFrom({
				[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
				[ELIZA_MODEL_GATEWAY_TOKEN]: "gw-token",
			}),
		);
		const applied = applyModelGateway(
			{ baseURL: "https://api.openai.com/v1", apiKey: "sk-raw-secret" },
			resolution,
		);
		// Base URL is the gateway; api key is the gateway token, never the raw key.
		expect(applied.baseURL).toBe("https://broker.example/v1");
		expect(applied.apiKey).toBe("gw-token");
		expect(applied.apiKey).not.toBe("sk-raw-secret");
		// Exhaustively confirm no raw key material survives anywhere in the pair.
		expect(JSON.stringify(applied)).not.toContain("sk-raw-secret");
	});

	it("scrubs the raw key even when the gateway has no token (api key becomes undefined, never the raw key)", () => {
		const resolution = resolveModelGateway(
			settingsFrom({
				[ELIZA_MODEL_GATEWAY_URL]: "https://broker.example/v1",
			}),
		);
		const applied = applyModelGateway(
			{ baseURL: "https://api.openai.com/v1", apiKey: "sk-raw-secret" },
			resolution,
		);
		expect(applied.apiKey).toBeUndefined();
		expect(JSON.stringify(applied)).not.toContain("sk-raw-secret");
	});

	it("falls back to the raw base URL only when the gateway resolution omits one (defensive)", () => {
		// applyModelGateway prefers resolution.baseURL; when enabled it is always
		// defined, but the ?? fallback keeps callers safe if that ever changes.
		const applied = applyModelGateway(
			{ baseURL: "https://api.openai.com/v1", apiKey: "sk-raw" },
			{
				enabled: true,
				strict: false,
				baseURL: undefined,
				apiKey: "gw-token",
			},
		);
		expect(applied.baseURL).toBe("https://api.openai.com/v1");
		expect(applied.apiKey).toBe("gw-token");
		expect(applied.apiKey).not.toBe("sk-raw");
	});
});
