/**
 * Covers the shared connector-config inspection helpers.
 *
 * The credential-key builders carry a security-relevant property the module
 * documents explicitly: segments are length-prefixed so distinct identifiers
 * can never collide into one secret-setting key. Two accounts must not be able
 * to read each other's credential because their ids differ only by a separator
 * character — so the collision cases here are adversarial, not cosmetic.
 *
 * `isConnectorConfigured` is the single source of truth behind every plugin's
 * auto-enable predicate, so `enabled: false` must win over present credentials
 * and each connector-specific branch must be pinned.
 *
 * Pure functions — no runtime, no IO.
 */
import { describe, expect, it } from "vitest";

import {
	connectorAccountCredentialSettingKey,
	connectorBaseCredentialSettingKey,
	isConnectorConfigured,
	isGoogleChatConfigured,
	isWechatConfigured,
} from "./connector-config.ts";

describe("credential setting keys", () => {
	it("length-prefixes each segment", () => {
		expect(
			connectorAccountCredentialSettingKey("slack", "acct1", "token"),
		).toBe("CONNECTOR|5:slack|ACCOUNT|5:acct1|5:token");
		expect(connectorBaseCredentialSettingKey("slack", "token")).toBe(
			"CONNECTOR|5:slack|BASE|5:token",
		);
	});

	it("keeps account and base credentials in separate namespaces", () => {
		expect(
			connectorAccountCredentialSettingKey("slack", "acct1", "token"),
		).not.toBe(connectorBaseCredentialSettingKey("slack", "token"));
	});

	it("does not collapse ids that differ only by separator character", () => {
		// The documented reason for length-prefixing: slug normalization would
		// make these two accounts share one credential.
		expect(
			connectorAccountCredentialSettingKey("slack", "support-east", "token"),
		).not.toBe(
			connectorAccountCredentialSettingKey("slack", "support_east", "token"),
		);
	});

	it("resists a separator injected into an identifier", () => {
		// Without length prefixes, "a|ACCOUNT|b" could be crafted to reshape the key.
		const crafted = connectorAccountCredentialSettingKey(
			"slack",
			"a|ACCOUNT|b",
			"token",
		);
		const plain = connectorAccountCredentialSettingKey("slack", "a", "token");
		expect(crafted).not.toBe(plain);
		expect(crafted).toContain("11:a|ACCOUNT|b");
	});

	it("keeps a shifted boundary between adjacent segments distinct", () => {
		expect(connectorAccountCredentialSettingKey("ab", "c", "token")).not.toBe(
			connectorAccountCredentialSettingKey("a", "bc", "token"),
		);
	});

	it("handles empty segments without collapsing them", () => {
		expect(connectorAccountCredentialSettingKey("slack", "", "token")).toBe(
			"CONNECTOR|5:slack|ACCOUNT|0:|5:token",
		);
	});
});

describe("isConnectorConfigured", () => {
	it("rejects a missing or non-object config", () => {
		for (const value of [null, undefined, "x", 42, true]) {
			expect(isConnectorConfigured("slack", value)).toBe(false);
		}
	});

	it("lets enabled:false win over present credentials", () => {
		expect(
			isConnectorConfigured("slack", { enabled: false, botToken: "t" }),
		).toBe(false);
	});

	it("accepts any of the universal credential fields", () => {
		for (const field of ["botToken", "token", "apiKey"]) {
			expect(isConnectorConfigured("anything", { [field]: "value" })).toBe(
				true,
			);
		}
	});

	it("rejects an unknown connector with no universal credential", () => {
		expect(isConnectorConfigured("unknown-connector", { projectId: "p" })).toBe(
			false,
		);
	});

	it("requires both halves for bluebubbles", () => {
		expect(isConnectorConfigured("bluebubbles", { serverUrl: "u" })).toBe(
			false,
		);
		expect(isConnectorConfigured("bluebubbles", { password: "p" })).toBe(false);
		expect(
			isConnectorConfigured("bluebubbles", { serverUrl: "u", password: "p" }),
		).toBe(true);
	});

	it("requires both halves for discordLocal", () => {
		expect(isConnectorConfigured("discordLocal", { clientId: "i" })).toBe(
			false,
		);
		expect(
			isConnectorConfigured("discordLocal", {
				clientId: "i",
				clientSecret: "s",
			}),
		).toBe(true);
	});

	it("accepts any single signal for imessage", () => {
		expect(isConnectorConfigured("imessage", { cliPath: "/x" })).toBe(true);
		expect(isConnectorConfigured("imessage", { dbPath: "/x" })).toBe(true);
		expect(isConnectorConfigured("imessage", { enabled: true })).toBe(true);
		expect(isConnectorConfigured("imessage", {})).toBe(false);
	});

	it("accepts legacy and current whatsapp auth shapes", () => {
		expect(isConnectorConfigured("whatsapp", { authState: "s" })).toBe(true);
		expect(isConnectorConfigured("whatsapp", { sessionPath: "s" })).toBe(true);
		expect(isConnectorConfigured("whatsapp", { authDir: "d" })).toBe(true);
	});

	it("accepts a whatsapp account with authDir, ignoring disabled ones", () => {
		expect(
			isConnectorConfigured("whatsapp", {
				accounts: { a: { authDir: "d" } },
			}),
		).toBe(true);
		expect(
			isConnectorConfigured("whatsapp", {
				accounts: { a: { authDir: "d", enabled: false } },
			}),
		).toBe(false);
		expect(
			isConnectorConfigured("whatsapp", { accounts: { a: { other: 1 } } }),
		).toBe(false);
	});

	it("accepts twitch on any single signal", () => {
		expect(isConnectorConfigured("twitch", { accessToken: "t" })).toBe(true);
		expect(isConnectorConfigured("twitch", { clientId: "c" })).toBe(true);
		expect(isConnectorConfigured("twitch", { enabled: true })).toBe(true);
		expect(isConnectorConfigured("twitch", {})).toBe(false);
	});
});

describe("isGoogleChatConfigured", () => {
	it("requires service-account material, not just a projectId", () => {
		expect(isGoogleChatConfigured({ projectId: "p" })).toBe(false);
		expect(isGoogleChatConfigured({ serviceAccountFile: "/key.json" })).toBe(
			true,
		);
		expect(
			isGoogleChatConfigured({ serviceAccount: { client_email: "a" } }),
		).toBe(true);
		expect(isGoogleChatConfigured({ serviceAccountKey: "raw" })).toBe(true);
	});

	it("treats a blank credential string as unconfigured", () => {
		expect(isGoogleChatConfigured({ serviceAccount: "   " })).toBe(false);
	});

	it("lets enabled:false win, at the top level and per account", () => {
		expect(
			isGoogleChatConfigured({ enabled: false, serviceAccountFile: "/k.json" }),
		).toBe(false);
		expect(
			isGoogleChatConfigured({
				accounts: { a: { serviceAccountFile: "/k.json", enabled: false } },
			}),
		).toBe(false);
	});

	it("finds credentials on an enabled account entry", () => {
		expect(
			isGoogleChatConfigured({
				accounts: { a: { serviceAccountFile: "/k.json" } },
			}),
		).toBe(true);
	});

	it("rejects arrays and non-objects", () => {
		for (const value of [null, undefined, [], "x"]) {
			expect(isGoogleChatConfigured(value)).toBe(false);
		}
	});
});

describe("isWechatConfigured", () => {
	it("accepts a top-level apiKey and rejects an empty config", () => {
		expect(isWechatConfigured({ apiKey: "k" })).toBe(true);
		expect(isWechatConfigured({})).toBe(false);
		expect(isWechatConfigured(null)).toBe(false);
	});

	it("accepts an enabled account with an apiKey and skips disabled ones", () => {
		expect(isWechatConfigured({ accounts: { a: { apiKey: "k" } } })).toBe(true);
		expect(
			isWechatConfigured({ accounts: { a: { apiKey: "k", enabled: false } } }),
		).toBe(false);
	});

	it("lets enabled:false win over a present apiKey", () => {
		expect(isWechatConfigured({ enabled: false, apiKey: "k" })).toBe(false);
	});
});
