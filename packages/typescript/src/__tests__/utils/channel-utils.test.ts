import { describe, expect, it, vi } from "vitest";
import {
	listSenderLabelCandidates,
	logAckFailure,
	logInboundDrop,
	logTypingFailure,
	resolveSenderLabel,
} from "../../utils/channel-utils";

describe("channel-utils", () => {
	describe("resolveSenderLabel", () => {
		it("prefers display name and appends id when distinct", () => {
			expect(
				resolveSenderLabel({
					name: " Alice ",
					username: "alice_user",
					e164: "+15551234567",
				}),
			).toBe("Alice (+15551234567)");
		});

		it("falls back to id-like fields when no display label exists", () => {
			expect(
				resolveSenderLabel({
					e164: " +15551234567 ",
				}),
			).toBe("+15551234567");
		});
	});

	describe("listSenderLabelCandidates", () => {
		it("returns normalized unique sender labels", () => {
			expect(
				listSenderLabelCandidates({
					name: "Alice",
					username: "alice",
					tag: "alice",
					id: "user-123",
				}),
			).toEqual(["Alice", "alice", "user-123", "Alice (user-123)"]);
		});
	});

	describe("log helpers", () => {
		it("formats target suffix consistently", () => {
			const log = vi.fn();

			logInboundDrop({
				log,
				channel: "discord",
				reason: "ignored",
				target: "room-1",
			});
			logTypingFailure({
				log,
				channel: "discord",
				action: "start",
				target: "room-1",
				error: new Error("boom"),
			});
			logAckFailure({
				log,
				channel: "discord",
				target: "room-1",
				error: "cleanup failed",
			});

			expect(log.mock.calls).toEqual([
				["discord: drop ignored target=room-1"],
				["discord typing action=start failed target=room-1: Error: boom"],
				["discord ack cleanup failed target=room-1: cleanup failed"],
			]);
		});
	});
});
