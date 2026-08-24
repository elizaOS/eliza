import { describe, expect, it } from "vitest";
import {
	__resetSendPolicyForTests,
	getSendPolicy,
	registerSendPolicy,
} from "../send-policy.ts";

const policy = {
	shouldRequireApproval: async () => false,
	enqueueApproval: async () => ({ requestId: "r", preview: "p" }),
};

describe("send-policy registry", () => {
	it("returns null when no policy is registered", () => {
		const runtime = {} as never;
		expect(getSendPolicy(runtime)).toBeNull();
	});

	it("returns the registered policy", () => {
		const runtime = {} as never;
		registerSendPolicy(runtime, policy);
		expect(getSendPolicy(runtime)).toBe(policy);
	});

	it("policies are per-runtime (WeakMap keyed)", () => {
		const a = {} as never;
		const b = {} as never;
		registerSendPolicy(a, policy);
		expect(getSendPolicy(a)).toBe(policy);
		expect(getSendPolicy(b)).toBeNull();
	});

	it("reset removes the policy", () => {
		const runtime = {} as never;
		registerSendPolicy(runtime, policy);
		__resetSendPolicyForTests(runtime);
		expect(getSendPolicy(runtime)).toBeNull();
	});
});

describe("send-policy registry lifecycle", () => {
	const approvingPolicy = {
		shouldRequireApproval: async () => true,
		enqueueApproval: async () => ({ requestId: "r2", preview: "p2" }),
	};

	it("replaces an earlier policy when the same runtime registers twice", () => {
		const runtime = {} as never;
		registerSendPolicy(runtime, policy);
		registerSendPolicy(runtime, approvingPolicy);
		expect(getSendPolicy(runtime)).toBe(approvingPolicy);
		expect(getSendPolicy(runtime)).not.toBe(policy);
	});

	it("resetting a runtime that never registered is a safe no-op", () => {
		const runtime = {} as never;
		expect(() => __resetSendPolicyForTests(runtime)).not.toThrow();
		expect(getSendPolicy(runtime)).toBeNull();
	});

	it("accepts a fresh registration after reset", () => {
		const runtime = {} as never;
		registerSendPolicy(runtime, policy);
		__resetSendPolicyForTests(runtime);
		registerSendPolicy(runtime, approvingPolicy);
		expect(getSendPolicy(runtime)).toBe(approvingPolicy);
	});

	it("keeps two runtimes' distinct policies independent", () => {
		const a = {} as never;
		const b = {} as never;
		registerSendPolicy(a, policy);
		registerSendPolicy(b, approvingPolicy);
		expect(getSendPolicy(a)).toBe(policy);
		expect(getSendPolicy(b)).toBe(approvingPolicy);
	});
});
