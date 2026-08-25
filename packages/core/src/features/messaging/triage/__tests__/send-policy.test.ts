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
