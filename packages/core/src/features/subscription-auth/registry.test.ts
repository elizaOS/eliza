import { afterEach, describe, expect, it } from "vitest";
import {
	getSubscriptionAuthProvider,
	hasSubscriptionAuthProvider,
	listSubscriptionAuthProviders,
	registerSubscriptionAuthProvider,
	resetSubscriptionAuthProviders,
} from "./registry.ts";
import type { SubscriptionAuthProvider } from "./types.ts";

const codexLike: SubscriptionAuthProvider = {
	id: "openai-codex",
	detectExternalCredentials: () => ({
		accountId: "codex-cli",
		label: "Codex CLI",
		source: "codex-cli",
		configured: true,
		valid: true,
		expiresAt: null,
	}),
};

describe("subscription-auth registry", () => {
	afterEach(() => {
		resetSubscriptionAuthProviders();
	});

	it("registers and looks up a descriptor by id", () => {
		expect(hasSubscriptionAuthProvider("openai-codex")).toBe(false);
		registerSubscriptionAuthProvider(codexLike);
		expect(hasSubscriptionAuthProvider("openai-codex")).toBe(true);
		expect(getSubscriptionAuthProvider("openai-codex")).toBe(codexLike);
		expect(getSubscriptionAuthProvider("nope")).toBeUndefined();
	});

	it("lists every registered descriptor", () => {
		registerSubscriptionAuthProvider(codexLike);
		registerSubscriptionAuthProvider({ id: "gemini-cli" });
		expect(
			listSubscriptionAuthProviders()
				.map((p) => p.id)
				.sort(),
		).toEqual(["gemini-cli", "openai-codex"]);
	});

	it("overwrites a prior registration for the same id (plugin overrides built-in)", () => {
		const builtin: SubscriptionAuthProvider = {
			id: "openai-codex",
			detectExternalCredentials: () => null,
		};
		registerSubscriptionAuthProvider(builtin);
		registerSubscriptionAuthProvider(codexLike);
		expect(getSubscriptionAuthProvider("openai-codex")).toBe(codexLike);
		expect(listSubscriptionAuthProviders()).toHaveLength(1);
	});

	it("exposes discovered credentials verbatim to a draining host", () => {
		registerSubscriptionAuthProvider(codexLike);
		const discovered =
			getSubscriptionAuthProvider(
				"openai-codex",
			)?.detectExternalCredentials?.();
		expect(discovered).toMatchObject({
			accountId: "codex-cli",
			source: "codex-cli",
			valid: true,
		});
	});
});
