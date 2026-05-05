import { describe, expect, it } from "vitest";
import { DiscordMessageAdapter } from "../adapters/discord-adapter.ts";
import { GmailMessageAdapter } from "../adapters/gmail-adapter.ts";
import { IMessageMessageAdapter } from "../adapters/imessage-adapter.ts";
import { SignalMessageAdapter } from "../adapters/signal-adapter.ts";
import { TelegramMessageAdapter } from "../adapters/telegram-adapter.ts";
import { TwitterMessageAdapter } from "../adapters/twitter-adapter.ts";
import { WhatsappMessageAdapter } from "../adapters/whatsapp-adapter.ts";
import { NotYetImplementedError } from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

const cases = [
	{ name: "gmail", make: () => new GmailMessageAdapter(), service: "gmail" },
	{
		name: "discord",
		make: () => new DiscordMessageAdapter(),
		service: "discord",
	},
	{
		name: "telegram",
		make: () => new TelegramMessageAdapter(),
		service: "telegram",
	},
	{
		name: "twitter",
		make: () => new TwitterMessageAdapter(),
		service: "twitter",
	},
	{
		name: "imessage",
		make: () => new IMessageMessageAdapter(),
		service: "imessage",
	},
	{ name: "signal", make: () => new SignalMessageAdapter(), service: "signal" },
	{
		name: "whatsapp",
		make: () => new WhatsappMessageAdapter(),
		service: "whatsapp",
	},
];

describe("message adapters: graceful degradation", () => {
	for (const c of cases) {
		it(`${c.name}: isAvailable=false when underlying plugin missing`, () => {
			const adapter = c.make();
			const runtime = createFakeRuntime();
			expect(adapter.isAvailable(runtime)).toBe(false);
		});

		it(`${c.name}: listMessages returns [] when unavailable`, async () => {
			const adapter = c.make();
			const runtime = createFakeRuntime();
			const out = await adapter.listMessages(runtime, {});
			expect(out).toEqual([]);
		});

		it(`${c.name}: getMessage returns null when unavailable`, async () => {
			const adapter = c.make();
			const runtime = createFakeRuntime();
			const out = await adapter.getMessage(runtime, "abc");
			expect(out).toBeNull();
		});

		it(`${c.name}: sendDraft throws NotYetImplementedError when unavailable`, async () => {
			const adapter = c.make();
			const runtime = createFakeRuntime();
			await expect(
				adapter.sendDraft(runtime, "draft-1"),
			).rejects.toBeInstanceOf(NotYetImplementedError);
		});

		it(`${c.name}: createDraft throws NotYetImplementedError when unavailable`, async () => {
			const adapter = c.make();
			const runtime = createFakeRuntime();
			await expect(
				adapter.createDraft(runtime, {
					source: adapter.source,
					to: [{ identifier: "x" }],
					body: "hi",
				}),
			).rejects.toBeInstanceOf(NotYetImplementedError);
		});

		it(`${c.name}: isAvailable=true when underlying service present`, () => {
			const adapter = c.make();
			const runtime = createFakeRuntime({
				availableServices: new Set([c.service]),
			});
			expect(adapter.isAvailable(runtime)).toBe(true);
		});
	}
});
