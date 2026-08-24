/**
 * Unit tests for resolving the single message-interaction host authority:
 * the canonical service name, null when absent, pass-through of a well-shaped
 * host, and typed rejection of malformed registrations.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import type { IAgentRuntime } from "../../types/runtime";
import {
	MESSAGE_INTERACTION_HOST_SERVICE,
	type MessageInteractionHost,
	resolveMessageInteractionHost,
} from "./host";

function runtimeWithService(service: unknown): IAgentRuntime {
	return {
		getService: (name: string) =>
			name === MESSAGE_INTERACTION_HOST_SERVICE ? service : undefined,
	} as unknown as IAgentRuntime;
}

function wellShapedHost(): MessageInteractionHost {
	return {
		prepare: async () => {
			throw new Error("unused in this test");
		},
		consume: async () => {
			throw new Error("unused in this test");
		},
		revoke: async () => {
			throw new Error("unused in this test");
		},
		get: async () => null,
		registerEffectHandler: () => () => {},
	};
}

describe("MESSAGE_INTERACTION_HOST_SERVICE", () => {
	it("exposes the canonical service name connectors resolve through", () => {
		expect(MESSAGE_INTERACTION_HOST_SERVICE).toBe("message_interaction_host");
	});
});

describe("resolveMessageInteractionHost", () => {
	it("returns null when no host service is registered", () => {
		expect(resolveMessageInteractionHost(runtimeWithService(null))).toBeNull();
		expect(
			resolveMessageInteractionHost(runtimeWithService(undefined)),
		).toBeNull();
	});

	it("returns the registered host unchanged when all required members are functions", () => {
		const host = wellShapedHost();
		const resolved = resolveMessageInteractionHost(runtimeWithService(host));
		expect(resolved).toBe(host);
	});

	it.each([
		["prepare", { prepare: undefined }],
		["consume", { consume: undefined }],
		["revoke", { revoke: undefined }],
		["get", { get: undefined }],
		["registerEffectHandler", { registerEffectHandler: undefined }],
	])(
		"rejects a host missing %s with a typed unavailable error",
		(_member, override) => {
			const malformed = { ...wellShapedHost(), ...override };
			try {
				resolveMessageInteractionHost(runtimeWithService(malformed));
				throw new Error("expected resolveMessageInteractionHost to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(ElizaError);
				expect((error as ElizaError).code).toBe(
					"INVALID_MESSAGE_INTERACTION_HOST_SERVICE",
				);
				expect((error as Error).message).toContain("malformed");
			}
		},
	);

	it("rejects a host whose member is not a function", () => {
		const malformed = {
			...wellShapedHost(),
			prepare: "not-a-function",
		} as unknown as MessageInteractionHost;
		expect(() =>
			resolveMessageInteractionHost(runtimeWithService(malformed)),
		).toThrow(ElizaError);
	});
});
