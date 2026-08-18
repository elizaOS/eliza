/**
 * The sendMessageToTarget handler must project interaction blocks the same way
 * the reply path does. Live regression 2026-08-17: a sub-agent completion relay
 * carried a [FOLLOWUPS] block and handleSendMessage shipped the literal markup
 * to the Discord channel. Deterministic unit over the projection helpers the
 * handler now composes (buildDiscordReplyPayload → text without raw markers).
 */

import { describe, expect, it } from "vitest";
import { buildDiscordReplyPayload } from "../interactions";

const RELAY_TEXT =
	"wind-chimes ready. index.html created in app folder.\n\n[FOLLOWUPS]\nnavigate:/apps=View apps\nprompt:What can I do with this app?=Ask usage\n[/FOLLOWUPS]";

describe("send-handler interaction projection (live FOLLOWUPS leak)", () => {
	it("strips the raw block from the prose and yields components", () => {
		const runtime = { getSetting: () => "https://nubilio.org" };
		const rendered = buildDiscordReplyPayload(runtime, { text: RELAY_TEXT });
		expect(rendered.text).not.toContain("[FOLLOWUPS]");
		expect(rendered.text).not.toContain("[/FOLLOWUPS]");
		expect(rendered.text).toContain("wind-chimes ready");
		expect(rendered.components.length).toBeGreaterThan(0);
	});

	it("passes block-free text through byte-identical", () => {
		const runtime = { getSetting: () => undefined };
		const rendered = buildDiscordReplyPayload(runtime, {
			text: "plain relay text, no blocks",
		});
		expect(rendered.text).toBe("plain relay text, no blocks");
		expect(rendered.components).toEqual([]);
	});
});
