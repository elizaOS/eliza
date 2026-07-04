/**
 * Deterministic unit test for resolveSecretsBrokerConfig (features/secrets/
 * storage): the both-or-nothing gate that activates the broker only when url and
 * token are both non-blank, whitespace trimming, strict-flag parsing, and the
 * SecretsBrokerUnavailableError shape. Pure-function test — no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	resolveSecretsBrokerConfig,
	SECRETS_BROKER_STRICT_KEY,
	SECRETS_BROKER_TOKEN_KEY,
	SECRETS_BROKER_URL_KEY,
	SecretsBrokerUnavailableError,
} from "./broker-config.ts";

/**
 * Build a `getSetting`-shaped resolver from a plain record so the tests read
 * like the env they model.
 */
function settings(map: Record<string, string | undefined>) {
	return (key: string): string | undefined => map[key];
}

describe("resolveSecretsBrokerConfig — both-or-nothing gate", () => {
	it("returns undefined when neither url nor token is set (local default)", () => {
		expect(resolveSecretsBrokerConfig(settings({}))).toBeUndefined();
	});

	it("returns undefined when only the url is set (half-configured no-ops)", () => {
		expect(
			resolveSecretsBrokerConfig(
				settings({ [SECRETS_BROKER_URL_KEY]: "https://broker.example" }),
			),
		).toBeUndefined();
	});

	it("returns undefined when only the token is set", () => {
		expect(
			resolveSecretsBrokerConfig(
				settings({ [SECRETS_BROKER_TOKEN_KEY]: "handle-abc" }),
			),
		).toBeUndefined();
	});

	it("treats whitespace-only values as unset", () => {
		expect(
			resolveSecretsBrokerConfig(
				settings({
					[SECRETS_BROKER_URL_KEY]: "   ",
					[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
				}),
			),
		).toBeUndefined();
	});

	it("activates and trims when both url and token are present", () => {
		const cfg = resolveSecretsBrokerConfig(
			settings({
				[SECRETS_BROKER_URL_KEY]: "  https://broker.example  ",
				[SECRETS_BROKER_TOKEN_KEY]: "  handle-abc  ",
			}),
		);
		expect(cfg).toEqual({
			url: "https://broker.example",
			token: "handle-abc",
			strict: false,
		});
	});

	it("parses strict as a truthy env flag", () => {
		const cfg = resolveSecretsBrokerConfig(
			settings({
				[SECRETS_BROKER_URL_KEY]: "https://broker.example",
				[SECRETS_BROKER_TOKEN_KEY]: "handle-abc",
				[SECRETS_BROKER_STRICT_KEY]: "1",
			}),
		);
		expect(cfg?.strict).toBe(true);
	});
});

describe("SecretsBrokerUnavailableError", () => {
	it("names the broker url and carries the cause", () => {
		const cause = new Error("ECONNREFUSED");
		const err = new SecretsBrokerUnavailableError(
			"https://broker.example",
			cause,
		);
		expect(err.name).toBe("SecretsBrokerUnavailableError");
		expect(err.brokerUrl).toBe("https://broker.example");
		expect(err.message).toContain("https://broker.example");
		expect((err as { cause?: unknown }).cause).toBe(cause);
	});
});
