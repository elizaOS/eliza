import { describe, expect, it } from "vitest";
import {
	resolveSecretsBrokerConfig,
	SecretsBrokerUnavailableError,
} from "./broker-config.ts";

describe("resolveSecretsBrokerConfig", () => {
	it("is undefined when either url or token is missing", () => {
		expect(resolveSecretsBrokerConfig(() => undefined)).toBeUndefined();
		expect(
			resolveSecretsBrokerConfig((k) =>
				k === "ELIZA_SECRETS_BROKER_URL" ? "https://broker" : undefined,
			),
		).toBeUndefined();
		expect(
			resolveSecretsBrokerConfig((k) =>
				k === "ELIZA_SECRETS_BROKER_TOKEN" ? "tok" : undefined,
			),
		).toBeUndefined();
	});

	it("activates only when both url and token are present", () => {
		const cfg = resolveSecretsBrokerConfig((k) => {
			const values: Record<string, string> = {
				ELIZA_SECRETS_BROKER_URL: "https://broker.example",
				ELIZA_SECRETS_BROKER_TOKEN: "agent-handle",
			};
			return values[k];
		});
		expect(cfg).toBeDefined();
		expect(cfg?.url).toBe("https://broker.example");
		expect(cfg?.token).toBe("agent-handle");
	});

	it("trims whitespace and treats empty as absent", () => {
		const cfg = resolveSecretsBrokerConfig((k) => {
			const values: Record<string, string> = {
				ELIZA_SECRETS_BROKER_URL: "  https://broker  ",
				ELIZA_SECRETS_BROKER_TOKEN: "   ",
			};
			return values[k];
		});
		expect(cfg).toBeUndefined();
	});

	it("parses the strict flag", () => {
		const cfg = resolveSecretsBrokerConfig((k) => {
			const values: Record<string, string> = {
				ELIZA_SECRETS_BROKER_URL: "https://broker",
				ELIZA_SECRETS_BROKER_TOKEN: "tok",
				ELIZA_SECRETS_BROKER_STRICT: "1",
			};
			return values[k];
		});
		expect(cfg?.strict).toBe(true);
	});
});

describe("SecretsBrokerUnavailableError", () => {
	it("carries the broker url and names the strict mode", () => {
		const err = new SecretsBrokerUnavailableError("https://broker");
		expect(err.name).toBe("SecretsBrokerUnavailableError");
		expect(err.brokerUrl).toBe("https://broker");
		expect(err.message).toContain("Refusing to fall back to local storage");
		expect(err.message).toContain("ELIZA_SECRETS_BROKER_STRICT");
		expect(err instanceof Error).toBe(true);
	});
});
