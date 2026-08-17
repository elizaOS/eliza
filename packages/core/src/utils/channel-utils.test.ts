/**
 * Channel decision gates. resolveMentionGating decides whether the agent even
 * processes a message: it must SKIP only when a mention is required, detectable,
 * and absent — an implicit mention (reply) or an authorized command bypass
 * counts as mentioned. Getting this wrong makes the bot either ignore people who
 * @-mentioned it or spam every message in a group.
 */

import { describe, expect, it } from "vitest";
import {
	formatLocationText,
	listSenderLabelCandidates,
	normalizeChatType,
	resolveMentionGating,
	resolveMentionGatingWithBypass,
	resolveSenderLabel,
	shouldAckReaction,
	toLocationContext,
} from "./channel-utils.ts";

describe("normalizeChatType", () => {
	it("folds platform synonyms into direct/group/channel", () => {
		expect(normalizeChatType("dm")).toBe("direct");
		expect(normalizeChatType("private")).toBe("direct");
		expect(normalizeChatType("supergroup")).toBe("group");
		expect(normalizeChatType("broadcast")).toBe("channel");
		expect(normalizeChatType(undefined)).toBe("direct");
		expect(normalizeChatType("weird")).toBe("direct");
	});
});

describe("resolveMentionGating", () => {
	it("skips only when a mention is required, detectable, and absent", () => {
		expect(
			resolveMentionGating({
				requireMention: true,
				canDetectMention: true,
				wasMentioned: false,
			}),
		).toEqual({ effectiveWasMentioned: false, shouldSkip: true });

		// explicit mention → processed
		expect(
			resolveMentionGating({
				requireMention: true,
				canDetectMention: true,
				wasMentioned: true,
			}).shouldSkip,
		).toBe(false);
	});

	it("treats an implicit mention (reply) or bypass as mentioned", () => {
		const base = {
			requireMention: true,
			canDetectMention: true,
			wasMentioned: false,
		};
		expect(resolveMentionGating({ ...base, implicitMention: true })).toEqual({
			effectiveWasMentioned: true,
			shouldSkip: false,
		});
		expect(
			resolveMentionGating({ ...base, shouldBypassMention: true }).shouldSkip,
		).toBe(false);
	});

	it("never skips when mention is not required or not detectable", () => {
		expect(
			resolveMentionGating({
				requireMention: false,
				canDetectMention: true,
				wasMentioned: false,
			}).shouldSkip,
		).toBe(false);
		expect(
			resolveMentionGating({
				requireMention: true,
				canDetectMention: false,
				wasMentioned: false,
			}).shouldSkip,
		).toBe(false);
	});
});

describe("resolveMentionGatingWithBypass", () => {
	it("lets an authorized control command bypass the mention gate in a group", () => {
		const result = resolveMentionGatingWithBypass({
			isGroup: true,
			requireMention: true,
			canDetectMention: true,
			wasMentioned: false,
			allowTextCommands: true,
			hasControlCommand: true,
			commandAuthorized: true,
		});
		expect(result.shouldBypassMention).toBe(true);
		expect(result.shouldSkip).toBe(false);
	});

	it("does not bypass for an unauthorized command", () => {
		const result = resolveMentionGatingWithBypass({
			isGroup: true,
			requireMention: true,
			canDetectMention: true,
			wasMentioned: false,
			allowTextCommands: true,
			hasControlCommand: true,
			commandAuthorized: false,
		});
		expect(result.shouldBypassMention).toBe(false);
		expect(result.shouldSkip).toBe(true);
	});
});

describe("shouldAckReaction", () => {
	const base = {
		isDirect: false,
		isGroup: true,
		isMentionableGroup: true,
		requireMention: true,
		canDetectMention: true,
		effectiveWasMentioned: true,
	};

	it("honors scope: off/all/direct/group-all", () => {
		expect(shouldAckReaction({ ...base, scope: "off" })).toBe(false);
		expect(shouldAckReaction({ ...base, scope: "all" })).toBe(true);
		expect(
			shouldAckReaction({ ...base, scope: "direct", isDirect: true }),
		).toBe(true);
		expect(shouldAckReaction({ ...base, scope: "group-all" })).toBe(true);
	});

	it("group-mentions only acks a detectable mention in a mentionable group", () => {
		expect(shouldAckReaction({ ...base, scope: "group-mentions" })).toBe(true);
		expect(
			shouldAckReaction({
				...base,
				scope: "group-mentions",
				requireMention: false,
				effectiveWasMentioned: true,
			}),
		).toBe(true);
		expect(
			shouldAckReaction({
				...base,
				scope: "group-mentions",
				effectiveWasMentioned: false,
			}),
		).toBe(false);
		expect(
			shouldAckReaction({
				...base,
				scope: "group-mentions",
				isMentionableGroup: false,
			}),
		).toBe(false);
	});
});

describe("formatLocationText", () => {
	it("formats basic pin location with coordinates and positive accuracy", () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy: 15.4,
			}),
		).toBe("📍 37.774900, -122.419400 ±15m");
	});

	it("sanitizes negative or non-finite accuracy values by omitting accuracy", () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy: -15,
			}),
		).toBe("📍 37.774900, -122.419400");

		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy: Number.NaN,
			}),
		).toBe("📍 37.774900, -122.419400");

		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy: Number.POSITIVE_INFINITY,
			}),
		).toBe("📍 37.774900, -122.419400");
	});

	it("preserves zero accuracy as a valid non-negative measurement", () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy: 0,
			}),
		).toBe("📍 37.774900, -122.419400 ±0m");
	});

	it("formats named place location with label and coordinates", () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				name: "San Francisco City Hall",
				address: "1 Dr Carlton B Goodlett Pl",
			}),
		).toBe(
			"📍 San Francisco City Hall — 1 Dr Carlton B Goodlett Pl (37.774900, -122.419400)",
		);
	});

	it("formats live location indicator and includes caption when present", () => {
		expect(
			formatLocationText({
				latitude: 37.7749,
				longitude: -122.4194,
				isLive: true,
				caption: "Sharing live route for 15 mins",
			}),
		).toBe(
			"🛰 Live location: 37.774900, -122.419400\nSharing live route for 15 mins",
		);
	});
});

describe("toLocationContext", () => {
	it("converts normalized location and sanitizes negative accuracy to undefined", () => {
		const context = toLocationContext({
			latitude: 37.7749,
			longitude: -122.4194,
			accuracy: -10,
			name: "Test Place",
		});

		expect(context).toEqual({
			LocationLat: 37.7749,
			LocationLon: -122.4194,
			LocationAccuracy: undefined,
			LocationName: "Test Place",
			LocationAddress: undefined,
			LocationSource: "place",
			LocationIsLive: false,
		});
	});

	it("preserves valid positive accuracy in location context", () => {
		const context = toLocationContext({
			latitude: 37.7749,
			longitude: -122.4194,
			accuracy: 25,
		});

		expect(context.LocationAccuracy).toBe(25);
	});

	it("omits non-finite accuracy without fabricating a measurement", () => {
		for (const accuracy of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const context = toLocationContext({
				latitude: 37.7749,
				longitude: -122.4194,
				accuracy,
			});

			expect(context.LocationAccuracy).toBeUndefined();
		}
	});
});

describe("resolveSenderLabel and listSenderLabelCandidates", () => {
	it("resolves display with id when both differ", () => {
		expect(
			resolveSenderLabel({
				name: "Alice",
				id: "u123",
			}),
		).toBe("Alice (u123)");
	});

	it("falls back gracefully when only id or only name is provided", () => {
		expect(resolveSenderLabel({ id: "u123" })).toBe("u123");
		expect(resolveSenderLabel({ name: "Alice" })).toBe("Alice");
		expect(resolveSenderLabel({})).toBeNull();
	});

	it("lists all distinct sender label candidates", () => {
		const candidates = listSenderLabelCandidates({
			name: "Alice",
			username: "alice_w",
			id: "u123",
		});

		expect(candidates).toContain("Alice");
		expect(candidates).toContain("alice_w");
		expect(candidates).toContain("u123");
		expect(candidates).toContain("Alice (u123)");
	});
});
