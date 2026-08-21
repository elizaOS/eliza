/**
 * Verify-token handshake contract for the plugin's Meta webhook subscription:
 * verifyWebhook must accept only an exact configured token — compared through
 * the constant-time helper, so prefix near-misses and length mismatches
 * reject. Deterministic: the service is constructed with an inert runtime and
 * its configs injected directly (same harness as webhook-account-idempotency).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";
import { timingSafeEqualSecretString } from "../src/webhook-auth";

const VERIFY_TOKEN = "meta-verify-token-0123456789";

function inertRuntime(): IAgentRuntime {
	return {
		getSetting: vi.fn(() => undefined),
		logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
	} as never as IAgentRuntime;
}

function serviceWithVerifyToken(token: string | undefined): WhatsAppConnectorService {
	const service = new WhatsAppConnectorService(inertRuntime());
	Object.assign(service, {
		defaultAccountId: "default",
		configs: new Map([
			[
				"default",
				{
					accountId: "default",
					transport: "cloudapi",
					accessToken: "access-token",
					phoneNumberId: "phone-1",
					webhookVerifyToken: token,
				},
			],
		]),
	});
	return service;
}

describe("WhatsAppConnectorService.verifyWebhook — constant-time token check", () => {
	it("returns the challenge for the exact configured token", () => {
		const service = serviceWithVerifyToken(VERIFY_TOKEN);
		expect(service.verifyWebhook("subscribe", VERIFY_TOKEN, "challenge-1")).toBe("challenge-1");
	});

	it("rejects a wrong token and a prefix near-miss", () => {
		const service = serviceWithVerifyToken(VERIFY_TOKEN);
		expect(service.verifyWebhook("subscribe", "wrong-token", "challenge-1")).toBeNull();
		expect(service.verifyWebhook("subscribe", VERIFY_TOKEN.slice(0, -1), "challenge-1")).toBeNull();
	});

	it("rejects a non-subscribe mode and fails closed with no configured token", () => {
		const service = serviceWithVerifyToken(VERIFY_TOKEN);
		expect(service.verifyWebhook("unsubscribe", VERIFY_TOKEN, "challenge-1")).toBeNull();
		const unconfigured = serviceWithVerifyToken(undefined);
		expect(unconfigured.verifyWebhook("subscribe", VERIFY_TOKEN, "challenge-1")).toBeNull();
	});
});

describe("timingSafeEqualSecretString", () => {
	it("accepts exact matches and rejects mismatches of any length", () => {
		expect(timingSafeEqualSecretString("abc", "abc")).toBe(true);
		expect(timingSafeEqualSecretString("abc", "abd")).toBe(false);
		expect(timingSafeEqualSecretString("abc", "ab")).toBe(false);
		expect(timingSafeEqualSecretString("abc", "abcd")).toBe(false);
		expect(timingSafeEqualSecretString("", "")).toBe(true);
	});
});
