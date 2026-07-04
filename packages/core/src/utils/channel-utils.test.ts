/**
 * Channel decision gates. resolveMentionGating decides whether the agent even
 * processes a message: it must SKIP only when a mention is required, detectable,
 * and absent — an implicit mention (reply) or an authorized command bypass
 * counts as mentioned. Getting this wrong makes the bot either ignore people who
 * @-mentioned it or spam every message in a group.
 */

import { describe, expect, it } from "vitest";
import {
	normalizeChatType,
	resolveMentionGating,
	resolveMentionGatingWithBypass,
	shouldAckReaction,
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
