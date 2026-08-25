import { describe, expect, it } from "vitest";
import {
	applyCanonicalSetupConfig,
	isTimeoutError,
	normalizeEnvValue,
} from "./config-like";

type MutableConfig = Record<string, unknown>;

describe("applyCanonicalSetupConfig", () => {
	it("leaves the config untouched when no args are provided", () => {
		const config = { cloud: { enabled: true } };
		applyCanonicalSetupConfig(config, {});
		expect(config).toEqual({ cloud: { enabled: true } });
	});

	it("persists a deployment target as a defensive copy", () => {
		const config = {};
		const target = { name: "prod", url: "https://example.com" };
		applyCanonicalSetupConfig(config, { deploymentTarget: target });
		expect(config.deploymentTarget).toEqual(target);
		expect(config.deploymentTarget).not.toBe(target);
	});

	it("deletes the deployment target when null is passed", () => {
		const config = { deploymentTarget: { name: "prod" } };
		applyCanonicalSetupConfig(config, { deploymentTarget: null });
		expect(config).not.toHaveProperty("deploymentTarget");
	});

	it("ignores an undefined deployment target", () => {
		const config = { deploymentTarget: { name: "prod" } };
		applyCanonicalSetupConfig(config, { deploymentTarget: undefined });
		expect(config.deploymentTarget).toEqual({ name: "prod" });
	});

	it("merges linked accounts into the existing map", () => {
		const config = { linkedAccounts: { a: { token: "t1" } } };
		applyCanonicalSetupConfig(config, {
			linkedAccounts: { b: { token: "t2" } },
		});
		expect(config.linkedAccounts).toEqual({
			a: { token: "t1" },
			b: { token: "t2" },
		});
	});

	it("deletes an emptied linked account entry", () => {
		const config = { linkedAccounts: { a: { token: "t1" }, b: { token: "t2" } } };
		applyCanonicalSetupConfig(config, { linkedAccounts: { a: {} } });
		expect(config.linkedAccounts).toEqual({ b: { token: "t2" } });
	});

	it("removes the linkedAccounts key entirely when the last account is dropped", () => {
		const config = { linkedAccounts: { a: { token: "t1" } } };
		applyCanonicalSetupConfig(config, { linkedAccounts: { a: null } });
		expect(config).not.toHaveProperty("linkedAccounts");
	});

	it("stores service routes and clears capabilities from clearRoutes first", () => {
		const config = { serviceRouting: { chat: { url: "old" }, mail: { url: "m" } } };
		applyCanonicalSetupConfig(config, {
			serviceRouting: { chat: { url: "new" } },
			clearRoutes: ["mail"],
		});
		expect(config.serviceRouting).toEqual({ chat: { url: "new" } });
	});

	it("drops an emptied service route capability", () => {
		const config = { serviceRouting: { chat: { url: "c" }, mail: { url: "m" } } };
		applyCanonicalSetupConfig(config, { serviceRouting: { chat: {} } });
		expect(config.serviceRouting).toEqual({ mail: { url: "m" } });
	});

	it("removes the serviceRouting key entirely when it becomes empty", () => {
		const config = { serviceRouting: { chat: { url: "c" } } };
		applyCanonicalSetupConfig(config, { serviceRouting: { chat: {} } });
		expect(config).not.toHaveProperty("serviceRouting");
	});

	it("clears routes even when no replacement routing is passed", () => {
		const config = { serviceRouting: { chat: { url: "c" }, mail: { url: "m" } } };
		applyCanonicalSetupConfig(config, { clearRoutes: ["chat", "mail"] });
		expect(config).not.toHaveProperty("serviceRouting");
	});
});

describe("normalizeEnvValue", () => {
	it("trims surrounding whitespace", () => {
		expect(normalizeEnvValue("  value  ")).toBe("value");
	});

	it("returns undefined for whitespace-only strings", () => {
		expect(normalizeEnvValue("   ")).toBeUndefined();
		expect(normalizeEnvValue("")).toBeUndefined();
	});

	it("returns undefined for non-string values", () => {
		expect(normalizeEnvValue(42)).toBeUndefined();
		expect(normalizeEnvValue(null)).toBeUndefined();
		expect(normalizeEnvValue(undefined)).toBeUndefined();
	});
});

describe("isTimeoutError", () => {
	it("matches errors named TimeoutError or AbortError", () => {
		expect(isTimeoutError(new Error("nope"))).toBe(false);
		const timeout = new Error("nope");
		timeout.name = "TimeoutError";
		expect(isTimeoutError(timeout)).toBe(true);
		const abort = new Error("nope");
		abort.name = "AbortError";
		expect(isTimeoutError(abort)).toBe(true);
	});

	it("matches timeout phrasing in the message case-insensitively", () => {
		expect(isTimeoutError(new Error("request timed out"))).toBe(true);
		expect(isTimeoutError(new Error("TIMEOUT after 5s"))).toBe(true);
		expect(isTimeoutError(new Error("connection timeout"))).toBe(true);
	});

	it("returns false for unrelated errors and non-Error values", () => {
		expect(isTimeoutError(new Error("connection refused"))).toBe(false);
		expect(isTimeoutError("timeout")).toBe(false);
		expect(isTimeoutError(undefined)).toBe(false);
		expect(isTimeoutError({ message: "timed out" })).toBe(false);
	});
});
