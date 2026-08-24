/**
 * Channel decision gates. resolveMentionGating decides whether the agent even
 * processes a message: it must SKIP only when a mention is required, detectable,
 * and absent — an implicit mention (reply) or an authorized command bypass
 * counts as mentioned. Getting this wrong makes the bot either ignore people who
 * @-mentioned it or spam every message in a group.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createTypingCallbacks,
	formatLocationText,
	listSenderLabelCandidates,
	logAckFailure,
	logInboundDrop,
	logTypingFailure,
	normalizeChatType,
	removeAckReactionAfterReply,
	resolveMentionGating,
	resolveMentionGatingWithBypass,
	resolveSenderLabel,
	shouldAckReaction,
	shouldAckReactionForWhatsApp,
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

	it("lists all distinct sender label candidates including tags and phone numbers", () => {
		const candidates = listSenderLabelCandidates({
			name: "Alice",
			username: "alice_w",
			tag: "alice#0001",
			e164: "+15551234567",
			id: "u123",
		});

		expect(candidates).toContain("Alice");
		expect(candidates).toContain("alice_w");
		expect(candidates).toContain("alice#0001");
		expect(candidates).toContain("+15551234567");
		expect(candidates).toContain("u123");
		expect(candidates).toContain("Alice (+15551234567)");
	});
});

describe("createTypingCallbacks", () => {
	it("executes start and handles start error with onStartError", async () => {
		const start = vi.fn().mockRejectedValue(new Error("network failure"));
		const onStartError = vi.fn();
		const callbacks = createTypingCallbacks({
			start,
			onStartError,
		});

		await callbacks.onReplyStart();
		expect(start).toHaveBeenCalledOnce();
		expect(onStartError).toHaveBeenCalledWith(expect.any(Error));
		expect(callbacks.onIdle).toBeUndefined();
	});

	it("executes stop on idle and forwards stop error to onStopError", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const stop = vi.fn().mockRejectedValue(new Error("stop failure"));
		const onStartError = vi.fn();
		const onStopError = vi.fn();

		const callbacks = createTypingCallbacks({
			start,
			stop,
			onStartError,
			onStopError,
		});

		await callbacks.onReplyStart();
		expect(start).toHaveBeenCalledOnce();

		expect(callbacks.onIdle).toBeDefined();
		callbacks.onIdle?.();
		expect(stop).toHaveBeenCalledOnce();

		// Allow microtask to run for the rejected stop promise
		await Promise.resolve();
		expect(onStopError).toHaveBeenCalledWith(expect.any(Error));
		expect(onStartError).not.toHaveBeenCalled();
	});

	it("falls back to onStartError when onStopError is omitted", async () => {
		const start = vi.fn().mockResolvedValue(undefined);
		const stop = vi.fn().mockRejectedValue(new Error("stop failure"));
		const onStartError = vi.fn();

		const callbacks = createTypingCallbacks({
			start,
			stop,
			onStartError,
		});

		callbacks.onIdle?.();
		await Promise.resolve();
		expect(onStartError).toHaveBeenCalledWith(expect.any(Error));
	});
});

describe("shouldAckReactionForWhatsApp", () => {
	const base = {
		emoji: "👀",
		isDirect: false,
		isGroup: true,
		directEnabled: true,
		groupMode: "mentions" as const,
		wasMentioned: true,
		groupActivated: false,
	};

	it("returns false if emoji is empty", () => {
		expect(shouldAckReactionForWhatsApp({ ...base, emoji: "" })).toBe(false);
	});

	it("handles direct chats based on directEnabled", () => {
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				isDirect: true,
				isGroup: false,
				directEnabled: true,
			}),
		).toBe(true);
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				isDirect: true,
				isGroup: false,
				directEnabled: false,
			}),
		).toBe(false);
	});

	it("returns false for non-group non-direct chats", () => {
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				isDirect: false,
				isGroup: false,
			}),
		).toBe(false);
	});

	it("handles groupMode never and always", () => {
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				groupMode: "never",
			}),
		).toBe(false);
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				groupMode: "always",
			}),
		).toBe(true);
	});

	it("handles groupMode mentions with explicit mention or group activation", () => {
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				groupMode: "mentions",
				wasMentioned: true,
				groupActivated: false,
			}),
		).toBe(true);
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				groupMode: "mentions",
				wasMentioned: false,
				groupActivated: true,
			}),
		).toBe(true);
		expect(
			shouldAckReactionForWhatsApp({
				...base,
				groupMode: "mentions",
				wasMentioned: false,
				groupActivated: false,
			}),
		).toBe(false);
	});
});

describe("removeAckReactionAfterReply", () => {
	it("skips removal when removeAfterReply is false or ackReactionValue is null", () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		removeAckReactionAfterReply({
			removeAfterReply: false,
			ackReactionPromise: Promise.resolve(true),
			ackReactionValue: "👀",
			remove,
		});
		expect(remove).not.toHaveBeenCalled();

		removeAckReactionAfterReply({
			removeAfterReply: true,
			ackReactionPromise: Promise.resolve(true),
			ackReactionValue: null,
			remove,
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("skips removal when ackReactionPromise resolves false", async () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		removeAckReactionAfterReply({
			removeAfterReply: true,
			ackReactionPromise: Promise.resolve(false),
			ackReactionValue: "👀",
			remove,
		});
		await Promise.resolve();
		expect(remove).not.toHaveBeenCalled();
	});

	it("invokes remove and handles removal failure via onError", async () => {
		const remove = vi.fn().mockRejectedValue(new Error("removal failed"));
		const onError = vi.fn();

		removeAckReactionAfterReply({
			removeAfterReply: true,
			ackReactionPromise: Promise.resolve(true),
			ackReactionValue: "👀",
			remove,
			onError,
		});

		await Promise.resolve();
		expect(remove).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(onError).toHaveBeenCalledWith(expect.any(Error));
	});
});

describe("channel logging helpers", () => {
	it("logs inbound message drop with and without target", () => {
		const log = vi.fn();
		logInboundDrop({
			log,
			channel: "telegram",
			reason: "unmentioned",
			target: "group-99",
		});
		expect(log).toHaveBeenCalledWith("telegram: drop unmentioned target=group-99");

		logInboundDrop({
			log,
			channel: "discord",
			reason: "muted",
		});
		expect(log).toHaveBeenCalledWith("discord: drop muted");
	});

	it("logs typing indicator failure with action and target", () => {
		const log = vi.fn();
		logTypingFailure({
			log,
			channel: "slack",
			action: "start",
			target: "C123",
			error: new Error("Rate limited"),
		});
		expect(log).toHaveBeenCalledWith(
			"slack typing action=start failed target=C123: Error: Rate limited",
		);

		logTypingFailure({
			log,
			channel: "whatsapp",
			error: "Network timeout",
		});
		expect(log).toHaveBeenCalledWith(
			"whatsapp typing failed: Network timeout",
		);
	});

	it("logs ack cleanup failure with and without target", () => {
		const log = vi.fn();
		logAckFailure({
			log,
			channel: "discord",
			target: "msg-456",
			error: "Unknown Message",
		});
		expect(log).toHaveBeenCalledWith(
			"discord ack cleanup failed target=msg-456: Unknown Message",
		);

		logAckFailure({
			log,
			channel: "telegram",
			error: "Bad Request",
		});
		expect(log).toHaveBeenCalledWith(
			"telegram ack cleanup failed: Bad Request",
		);
	});
});
