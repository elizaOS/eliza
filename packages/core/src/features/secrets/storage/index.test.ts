/**
 * Deterministic unit coverage for the features/secrets/storage entry barrel.
 * The suite pins the import-time bundle-safety anchor to the identities of
 * direct leaf imports, resolves every documented runtime export to its leaf
 * binding, and drives the re-exported broker resolver, fail-closed error, and
 * memory store through the barrel so each binding proves live at runtime.
 */
import { describe, expect, it } from "vitest";
import type { SecretContext } from "../types.ts";
import {
	resolveSecretsBrokerConfig as leafResolveConfig,
	SECRETS_BROKER_STRICT_KEY as leafStrictKey,
	SECRETS_BROKER_TOKEN_KEY as leafTokenKey,
	SecretsBrokerUnavailableError as leafUnavailableError,
	SECRETS_BROKER_URL_KEY as leafUrlKey,
} from "./broker-config.ts";
import { BrokerSecretStorage as leafBrokerStorage } from "./broker-store.ts";
import { CharacterSettingsStorage as leafCharacterStorage } from "./character-store.ts";
import { ComponentSecretStorage as leafComponentStorage } from "./component-store.ts";
import * as storageEntry from "./index.ts";
import {
	BaseSecretStorage as leafBaseStorage,
	CompositeSecretStorage as leafCompositeStorage,
} from "./interface.ts";
import { MemorySecretStorage as leafMemoryStorage } from "./memory-store.ts";
import { WorldMetadataStorage as leafWorldStorage } from "./world-store.ts";

const ANCHOR_KEY = "__bundle_safety_FEATURES_SECRETS_STORAGE_INDEX__";

function settingsFrom(values: Record<string, string>) {
	return (key: string): string | undefined => values[key];
}

describe("features/secrets/storage entry barrel", () => {
	it("retains every re-exported class binding in its import-time bundle-safety anchor", () => {
		const anchor = (globalThis as Record<string, unknown>)[ANCHOR_KEY];
		expect(Array.isArray(anchor)).toBe(true);
		const values = anchor as unknown[];
		expect(values).toHaveLength(7);
		expect(values).toContain(leafBrokerStorage);
		expect(values).toContain(leafCharacterStorage);
		expect(values).toContain(leafComponentStorage);
		expect(values).toContain(leafBaseStorage);
		expect(values).toContain(leafCompositeStorage);
		expect(values).toContain(leafMemoryStorage);
		expect(values).toContain(leafWorldStorage);
	});

	it("resolves each documented export to its leaf-module binding", () => {
		expect(storageEntry.BrokerSecretStorage).toBe(leafBrokerStorage);
		expect(storageEntry.CharacterSettingsStorage).toBe(leafCharacterStorage);
		expect(storageEntry.ComponentSecretStorage).toBe(leafComponentStorage);
		expect(storageEntry.BaseSecretStorage).toBe(leafBaseStorage);
		expect(storageEntry.CompositeSecretStorage).toBe(leafCompositeStorage);
		expect(storageEntry.MemorySecretStorage).toBe(leafMemoryStorage);
		expect(storageEntry.WorldMetadataStorage).toBe(leafWorldStorage);
		expect(storageEntry.SecretsBrokerUnavailableError).toBe(
			leafUnavailableError,
		);
		expect(storageEntry.resolveSecretsBrokerConfig).toBe(leafResolveConfig);
		expect(storageEntry.SECRETS_BROKER_URL_KEY).toBe(leafUrlKey);
		expect(storageEntry.SECRETS_BROKER_TOKEN_KEY).toBe(leafTokenKey);
		expect(storageEntry.SECRETS_BROKER_STRICT_KEY).toBe(leafStrictKey);
	});
});

describe("resolveSecretsBrokerConfig through the entry", () => {
	it("resolves a fully configured broker, trimming values and honouring strict mode", () => {
		const config = storageEntry.resolveSecretsBrokerConfig(
			settingsFrom({
				[storageEntry.SECRETS_BROKER_URL_KEY]: "  https://broker.example.com  ",
				[storageEntry.SECRETS_BROKER_TOKEN_KEY]: "\tagent-token\t",
				[storageEntry.SECRETS_BROKER_STRICT_KEY]: "true",
			}),
		);
		expect(config).toEqual({
			url: "https://broker.example.com",
			token: "agent-token",
			strict: true,
		});
	});

	it("stays off when only one of url or token is configured", () => {
		expect(
			storageEntry.resolveSecretsBrokerConfig(
				settingsFrom({
					[storageEntry.SECRETS_BROKER_URL_KEY]: "https://broker.example.com",
				}),
			),
		).toBeUndefined();
		expect(
			storageEntry.resolveSecretsBrokerConfig(
				settingsFrom({
					[storageEntry.SECRETS_BROKER_TOKEN_KEY]: "agent-token",
				}),
			),
		).toBeUndefined();
	});

	it("treats blank or whitespace-only settings as unset", () => {
		expect(
			storageEntry.resolveSecretsBrokerConfig(
				settingsFrom({
					[storageEntry.SECRETS_BROKER_URL_KEY]: "   ",
					[storageEntry.SECRETS_BROKER_TOKEN_KEY]: "agent-token",
				}),
			),
		).toBeUndefined();
		expect(
			storageEntry.resolveSecretsBrokerConfig(
				settingsFrom({
					[storageEntry.SECRETS_BROKER_URL_KEY]: "https://broker.example.com",
					[storageEntry.SECRETS_BROKER_TOKEN_KEY]: "",
				}),
			),
		).toBeUndefined();
	});

	it("parses the strict flag through canonical env truthiness", () => {
		const base = {
			[storageEntry.SECRETS_BROKER_URL_KEY]: "https://broker.example.com",
			[storageEntry.SECRETS_BROKER_TOKEN_KEY]: "agent-token",
		};
		expect(
			storageEntry.resolveSecretsBrokerConfig(settingsFrom(base))?.strict,
		).toBe(false);
		expect(
			storageEntry.resolveSecretsBrokerConfig(
				settingsFrom({
					...base,
					[storageEntry.SECRETS_BROKER_STRICT_KEY]: "0",
				}),
			)?.strict,
		).toBe(false);
		expect(
			storageEntry.resolveSecretsBrokerConfig(
				settingsFrom({
					...base,
					[storageEntry.SECRETS_BROKER_STRICT_KEY]: "enabled",
				}),
			)?.strict,
		).toBe(true);
	});
});

describe("fail-closed error through the entry", () => {
	it("constructs SecretsBrokerUnavailableError preserving url, cause, and name", () => {
		const cause = new Error("socket hang up");
		const error = new storageEntry.SecretsBrokerUnavailableError(
			"https://broker.example.com",
			cause,
		);
		expect(error).toBeInstanceOf(leafUnavailableError);
		expect(error.name).toBe("SecretsBrokerUnavailableError");
		expect(error.brokerUrl).toBe("https://broker.example.com");
		expect(error.cause).toBe(cause);
		expect(error.message).toContain("Refusing to fall back to local storage");
	});
});

describe("stores through the entry", () => {
	it("exposes a working MemorySecretStorage implementation", async () => {
		const storage = new storageEntry.MemorySecretStorage();
		await storage.initialize();
		const context: SecretContext = { level: "global", agentId: "agent-1" };

		await storage.set("API_KEY", "through-the-barrel", context);

		expect(await storage.get("API_KEY", context)).toBe("through-the-barrel");
		expect(await storage.exists("API_KEY", context)).toBe(true);
		expect(
			await storage.get("API_KEY", { level: "user", userId: "u-1" }),
		).toBeNull();
	});
});
