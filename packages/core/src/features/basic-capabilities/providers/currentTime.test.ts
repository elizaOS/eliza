/**
 * CURRENT_TIME contract tests prove device-first local rendering and honest
 * agent/host reference fallbacks at deterministic DST and date boundaries.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory } from "../../../types/index.ts";
import { currentTimeProvider, resolveMessageTimeZone } from "./currentTime.ts";

function runtime(timeZone?: string): IAgentRuntime {
	return {
		getSetting: (key: string) => (key === "TIMEZONE" ? timeZone : null),
	} as IAgentRuntime;
}

function message(uiTimeZone?: unknown): Memory {
	return {
		content: {
			text: "what time is it for me?",
			...(uiTimeZone !== undefined ? { metadata: { uiTimeZone } } : {}),
		},
	} as Memory;
}

describe("currentTimeProvider", () => {
	afterEach(() => vi.useRealTimers());

	it("uses the active device as the sender-local clock across a date boundary", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T02:41:04.618Z"));
		const result = await currentTimeProvider.get(
			runtime("Europe/Paris"),
			message("America/Los_Angeles"),
			{} as never,
		);

		expect(result.data).toMatchObject({
			date: "2026-08-04",
			timeZone: "America/Los_Angeles",
			userTimeZone: "America/Los_Angeles",
			timeZoneOrigin: "device",
		});
		expect(result.text).toContain("User local time:");
		expect(result.text).toContain("from the active device");
		expect(result.text).not.toContain("Europe/Paris");
	});

	it("lets a traveling device override the configured reference timezone", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-01T09:30:00.000Z"));
		const result = await currentTimeProvider.get(
			runtime("America/New_York"),
			message("America/Los_Angeles"),
			{} as never,
		);

		expect(result.data).toMatchObject({
			time: "01:30:00",
			timeZone: "America/Los_Angeles",
			timeZoneOrigin: "device",
		});
	});

	it("labels an agent setting as reference time when the sender zone is unknown", async () => {
		const result = await currentTimeProvider.get(
			runtime("Europe/Paris"),
			message(),
			{} as never,
		);

		expect(result.data).toMatchObject({
			timeZone: "Europe/Paris",
			userTimeZone: null,
			timeZoneOrigin: "agent-setting",
		});
		expect(result.text).toContain("User timezone: unknown");
		expect(result.text).toContain("Agent reference time:");
		expect(result.text).toContain("not the user's local time");
		expect(result.text).not.toContain("User local time:");
	});

	it("labels the host clock as server time when no trusted sender zone exists", async () => {
		const result = await currentTimeProvider.get(
			runtime(),
			message(),
			{} as never,
		);
		const host = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

		expect(result.data).toMatchObject({
			timeZone: host,
			userTimeZone: null,
			timeZoneOrigin: "host",
		});
		expect(result.text).toContain("User timezone: unknown");
		expect(result.text).toContain("Server time:");
		expect(result.text).not.toContain("User local time:");
	});

	it.each(["Mars/Olympus_Mons", "\nUTC\rspoof", "", 42])(
		"rejects invalid device timezone %j",
		async (invalid) => {
			const result = await currentTimeProvider.get(
				runtime("Asia/Tokyo"),
				message(invalid),
				{} as never,
			);
			expect(result.data).toMatchObject({
				timeZone: "Asia/Tokyo",
				userTimeZone: null,
				timeZoneOrigin: "agent-setting",
			});
			if (String(invalid).length > 0) {
				expect(result.text).not.toContain(String(invalid));
			}
		},
	);
});

describe("resolveMessageTimeZone", () => {
	it("preserves device then setting then host precedence", () => {
		const host = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		expect(resolveMessageTimeZone(runtime("UTC"), message("Asia/Tokyo"))).toBe(
			"Asia/Tokyo",
		);
		expect(resolveMessageTimeZone(runtime("Europe/Paris"), message())).toBe(
			"Europe/Paris",
		);
		expect(resolveMessageTimeZone(runtime(), message())).toBe(host);
	});
});
