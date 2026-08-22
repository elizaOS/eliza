/**
 * Deterministic gate tests for the cross-channel SEARCH_MESSAGES triage
 * action: pins that the inbox-wide search stays unreachable from a group
 * chat's general-routed turn (its contexts and ADMIN role gate are the
 * cross-room privacy boundary — the room-scoped CHANNEL_RECAP action serves
 * current-room recaps instead) while remaining reachable on messaging-routed
 * turns. Pure, no model, no database.
 */
import { describe, expect, it } from "vitest";
import { filterByContextGate } from "../../../../runtime/context-gates.ts";
import type { Memory, UUID } from "../../../../types/index.ts";
import { searchMessagesAction } from "./searchMessages.ts";

const ROOM = "00000000-0000-4000-8000-00000000d00d" as UUID;

function routedMessage(primaryContext: string): Memory {
	return {
		id: "00000000-0000-4000-8000-000000000001" as UUID,
		entityId: "00000000-0000-4000-8000-000000000002" as UUID,
		roomId: ROOM,
		content: {
			text: "what were the last 100 messages in this chat? summary",
			metadata: { __responseContext: { primaryContext } },
		},
	} as Memory;
}

describe("SEARCH_MESSAGES cross-room gating", () => {
	it("declares only messaging/email/documents contexts — never general", () => {
		expect(searchMessagesAction.contexts).toEqual([
			"messaging",
			"email",
			"documents",
		]);
		expect(searchMessagesAction.contexts).not.toContain("general");
	});

	it("keeps the ADMIN role gate on inbox-wide search", () => {
		expect(searchMessagesAction.roleGate).toEqual({ minRole: "ADMIN" });
	});

	it("stays off the exposure surface of a general-routed group turn for any role", () => {
		for (const roles of [
			["GUEST"],
			["MEMBER"],
			["ADMIN"],
			["OWNER"],
		] as const) {
			const surfaced = filterByContextGate(
				[searchMessagesAction],
				["general"],
				roles,
			);
			expect(surfaced).toEqual([]);
		}
	});

	it("validate rejects a general-routed turn and accepts a messaging-routed one", async () => {
		await expect(
			searchMessagesAction.validate(
				undefined as never,
				routedMessage("general"),
				undefined,
			),
		).resolves.toBe(false);
		await expect(
			searchMessagesAction.validate(
				undefined as never,
				routedMessage("messaging"),
				undefined,
			),
		).resolves.toBe(true);
	});
});
