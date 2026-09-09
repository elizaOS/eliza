/**
 * FAILURE_REPLY_POLICY parsing and the shared should-emit gate. Pure logic:
 * no runtime, no connector. The connector and message-service tests cover
 * the wiring; this pins the contract they share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_FAILURE_REPLY_POLICY,
	isPrivateFailureReplyChannel,
	parseFailureReplyPolicy,
	resetFailureReplyPolicyWarnings,
	resolveFailureReplyPolicy,
	shouldEmitFailureReply,
} from "../failure-reply-policy";

describe("parseFailureReplyPolicy", () => {
	it("accepts the canonical values case-insensitively", () => {
		expect(parseFailureReplyPolicy("dm-only")).toBe("dm-only");
		expect(parseFailureReplyPolicy("DM_ONLY")).toBe("dm-only");
		expect(parseFailureReplyPolicy(" All ")).toBe("all");
		expect(parseFailureReplyPolicy("off")).toBe("off");
	});

	it("accepts obvious aliases", () => {
		expect(parseFailureReplyPolicy("dm")).toBe("dm-only");
		expect(parseFailureReplyPolicy("private")).toBe("dm-only");
		expect(parseFailureReplyPolicy("always")).toBe("all");
		expect(parseFailureReplyPolicy("everywhere")).toBe("all");
		expect(parseFailureReplyPolicy("none")).toBe("off");
		expect(parseFailureReplyPolicy("never")).toBe("off");
		expect(parseFailureReplyPolicy("silent")).toBe("off");
	});

	it("returns null for unknown, empty, or non-string values", () => {
		expect(parseFailureReplyPolicy("public")).toBeNull();
		expect(parseFailureReplyPolicy("")).toBeNull();
		expect(parseFailureReplyPolicy(undefined)).toBeNull();
		expect(parseFailureReplyPolicy(null)).toBeNull();
		expect(parseFailureReplyPolicy(true)).toBeNull();
		expect(parseFailureReplyPolicy(1)).toBeNull();
	});
});

describe("resolveFailureReplyPolicy", () => {
	beforeEach(() => {
		resetFailureReplyPolicyWarnings();
	});
	afterEach(() => {
		resetFailureReplyPolicyWarnings();
	});

	it("defaults to dm-only when nothing is configured", () => {
		expect(DEFAULT_FAILURE_REPLY_POLICY).toBe("dm-only");
		expect(resolveFailureReplyPolicy(undefined, { env: {} })).toBe("dm-only");
		expect(
			resolveFailureReplyPolicy({ getSetting: () => undefined }, { env: {} }),
		).toBe("dm-only");
	});

	it("prefers the runtime setting over the env", () => {
		expect(
			resolveFailureReplyPolicy(
				{ getSetting: (key) => (key === "FAILURE_REPLY_POLICY" ? "all" : "") },
				{ env: { FAILURE_REPLY_POLICY: "off" } },
			),
		).toBe("all");
	});

	it("falls back to the env when the runtime setting is unset", () => {
		expect(
			resolveFailureReplyPolicy(
				{ getSetting: () => undefined },
				{ env: { FAILURE_REPLY_POLICY: "off" } },
			),
		).toBe("off");
	});

	it("fails closed to dm-only on an unrecognized value and warns once per value", () => {
		const warn = vi.fn();
		const runtime = { getSetting: () => "loud" };
		expect(
			resolveFailureReplyPolicy(runtime, { env: {}, logger: { warn } }),
		).toBe("dm-only");
		expect(
			resolveFailureReplyPolicy(runtime, { env: {}, logger: { warn } }),
		).toBe("dm-only");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toMatchObject({
			setting: "FAILURE_REPLY_POLICY",
			value: "loud",
			fallback: "dm-only",
		});
		// A different bad value gets its own single warning.
		expect(
			resolveFailureReplyPolicy(
				{ getSetting: () => "public" },
				{ env: {}, logger: { warn } },
			),
		).toBe("dm-only");
		expect(warn).toHaveBeenCalledTimes(2);
	});
});

describe("isPrivateFailureReplyChannel", () => {
	it("treats DM, VOICE_DM, SELF and API as private", () => {
		for (const type of ["DM", "VOICE_DM", "SELF", "API", "dm"]) {
			expect(isPrivateFailureReplyChannel(type)).toBe(true);
		}
	});

	it("treats every group-style room and unknown input as public", () => {
		for (const type of [
			"GROUP",
			"THREAD",
			"VOICE_GROUP",
			"FORUM",
			"WORLD",
			"FEED",
			"",
			undefined,
			null,
		]) {
			expect(isPrivateFailureReplyChannel(type)).toBe(false);
		}
	});
});

describe("shouldEmitFailureReply", () => {
	it("dm-only: emits in private rooms, suppresses in public rooms", () => {
		expect(shouldEmitFailureReply({ policy: "dm-only", isDm: true })).toEqual({
			emit: true,
		});
		expect(shouldEmitFailureReply({ policy: "dm-only", isDm: false })).toEqual({
			emit: false,
			reason: "policy-dm-only-public-room",
		});
		expect(
			shouldEmitFailureReply({ policy: "dm-only", channelType: "DM" }).emit,
		).toBe(true);
		expect(
			shouldEmitFailureReply({ policy: "dm-only", channelType: "API" }).emit,
		).toBe(true);
		expect(
			shouldEmitFailureReply({ policy: "dm-only", channelType: "GROUP" }).emit,
		).toBe(false);
		expect(
			shouldEmitFailureReply({ policy: "dm-only", channelType: "THREAD" }).emit,
		).toBe(false);
	});

	it("dm-only: an explicit isDm verdict wins over channelType", () => {
		expect(
			shouldEmitFailureReply({
				policy: "dm-only",
				isDm: false,
				channelType: "DM",
			}).emit,
		).toBe(false);
		expect(
			shouldEmitFailureReply({
				policy: "dm-only",
				isDm: true,
				channelType: "GROUP",
			}).emit,
		).toBe(true);
	});

	it("dm-only: unknown room kind fails closed to silence", () => {
		expect(shouldEmitFailureReply({ policy: "dm-only" })).toEqual({
			emit: false,
			reason: "policy-dm-only-public-room",
		});
	});

	it("dm-only: autonomous turns keep the failure text", () => {
		expect(
			shouldEmitFailureReply({
				policy: "dm-only",
				channelType: "GROUP",
				isAutonomous: true,
			}).emit,
		).toBe(true);
	});

	it("all: emits everywhere", () => {
		expect(shouldEmitFailureReply({ policy: "all", isDm: false }).emit).toBe(
			true,
		);
		expect(
			shouldEmitFailureReply({ policy: "all", channelType: "GROUP" }).emit,
		).toBe(true);
	});

	it("off: suppresses everywhere, including DMs and autonomous turns", () => {
		expect(shouldEmitFailureReply({ policy: "off", isDm: true })).toEqual({
			emit: false,
			reason: "policy-off",
		});
		expect(
			shouldEmitFailureReply({ policy: "off", isAutonomous: true }).emit,
		).toBe(false);
	});
});
