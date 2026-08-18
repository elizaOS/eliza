/**
 * CURRENT_TIME user-timezone precedence tests. A deterministic runtime stub
 * and the provider's emitted ISO instant prove:
 *   - profile timezone wins and renders the user's local wall-clock PRIMARY
 *   - device (uiTimeZone) and agent TIMEZONE settings still resolve
 *   - an unknown user timezone renders an honest "unknown" state with the
 *     server clock clearly labeled — never host time masquerading as the
 *     user's wall-clock (the "8:35pm in brooklyn" UTC-math bug)
 *   - resolveMessageTimeZone keeps its device→setting→host precedence for
 *     scheduler humanization
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, Memory } from "../../../types/index.ts";
import {
	currentTimeProvider,
	resolveMessageTimeZone,
} from "./currentTime.ts";

function runtime(options?: {
	timeZone?: string;
	entity?: Entity | null;
}): IAgentRuntime {
	return {
		getSetting: (key: string) =>
			key === "TIMEZONE" ? (options?.timeZone ?? null) : null,
		getEntityById: async () => options?.entity ?? null,
	} as unknown as IAgentRuntime;
}

function message(uiTimeZone?: string): Memory {
	return {
		entityId: "6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
		content: {
			text: "schedule lunch tomorrow",
			...(uiTimeZone ? { metadata: { uiTimeZone } } : {}),
		},
	} as Memory;
}

function profileEntity(profile: Record<string, unknown>): Entity {
	return {
		id: "6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
		names: ["Shadow"],
		agentId: "00000000-0000-0000-0000-000000000001",
		metadata: { userProfile: profile },
	} as Entity;
}

function expectedDate(iso: unknown, timeZone: string): string {
	expect(typeof iso).toBe("string");
	return new Date(iso as string).toLocaleDateString("en-CA", { timeZone });
}

describe("currentTimeProvider", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the profile timezone as the user's local time, beating device and host", async () => {
		vi.useFakeTimers();
		// 2026-08-18T20:35Z == 16:35 EDT — the live repro instant.
		vi.setSystemTime(new Date("2026-08-18T20:35:00.000Z"));
		const result = await currentTimeProvider.get(
			runtime({
				entity: profileEntity({
					timezone: "America/New_York",
					timezoneSource: "explicit",
					location: "Brooklyn, NYC",
				}),
			}),
			message("America/Los_Angeles"),
			{} as never,
		);

		expect(result.data?.userTimeZone).toBe("America/New_York");
		expect(result.data?.userTimeZoneOrigin).toBe("profile");
		expect(result.data?.time).toBe("16:35:00");
		expect(result.text).toContain("America/New_York");
		expect(result.text).toContain("User location: Brooklyn, NYC");
		expect(result.text).toContain("ALREADY the user's wall-clock time");
		// The wall-clock line is the user's 16:35 EDT, not the host's 20:35 UTC.
		expect(result.text).toContain("- Time: 16:35:00 America/New_York");
		expect(result.text).not.toContain("- Time: 20:35:00");
	});

	it("formats relative-date context in the sending device timezone when no profile exists", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T02:41:04.618Z"));
		const result = await currentTimeProvider.get(
			runtime({ timeZone: "UTC" }),
			message("America/Los_Angeles"),
			{} as never,
		);

		expect(result.data?.timeZone).toBe("America/Los_Angeles");
		expect(result.data?.userTimeZoneOrigin).toBe("device");
		expect(result.data?.date).toBe(
			expectedDate(result.data?.iso, "America/Los_Angeles"),
		);
		expect(result.data?.date).toBe("2026-08-04");
		expect(result.text).toContain("- Date: 2026-08-04");
		expect(result.text).toContain("America/Los_Angeles");
	});

	it("declares the user timezone unknown instead of presenting the host clock as the user's", async () => {
		const result = await currentTimeProvider.get(
			runtime(),
			message(),
			{} as never,
		);

		expect(result.data?.userTimeZone).toBeNull();
		expect(result.data?.userTimeZoneOrigin).toBe("unknown");
		expect(result.text).toContain("User timezone: unknown");
		expect(result.text).toContain("the SERVER's clock, not the user's");
		expect(result.text).not.toContain("User's local time:");
	});

	it("rejects an invalid client timezone and uses the configured timezone", async () => {
		const result = await currentTimeProvider.get(
			runtime({ timeZone: "Europe/Paris" }),
			message("Mars/Olympus_Mons"),
			{} as never,
		);

		expect(result.data?.timeZone).toBe("Europe/Paris");
		expect(result.data?.userTimeZoneOrigin).toBe("agent-setting");
		expect(result.data?.date).toBe(
			expectedDate(result.data?.iso, "Europe/Paris"),
		);
		expect(result.text).not.toContain("Mars/Olympus_Mons");
	});

	it("rejects an invalid profile timezone and falls through to the device hint", async () => {
		const result = await currentTimeProvider.get(
			runtime({
				entity: profileEntity({ timezone: "Mars/Olympus_Mons" }),
			}),
			message("Asia/Tokyo"),
			{} as never,
		);

		expect(result.data?.userTimeZone).toBe("Asia/Tokyo");
		expect(result.data?.userTimeZoneOrigin).toBe("device");
		expect(result.text).not.toContain("Mars/Olympus_Mons");
	});

	it("degrades to the unknown state when the entity lookup throws", async () => {
		const throwingRuntime = {
			getSetting: () => null,
			getEntityById: async () => {
				throw new Error("db down");
			},
		} as unknown as IAgentRuntime;
		const result = await currentTimeProvider.get(
			throwingRuntime,
			message(),
			{} as never,
		);
		expect(result.data?.userTimeZoneOrigin).toBe("unknown");
		expect(result.text).toContain("User timezone: unknown");
	});
});

describe("resolveMessageTimeZone (scheduler humanization path)", () => {
	it("keeps device → setting → host precedence and never returns null", () => {
		const hostTimeZone =
			Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		expect(
			resolveMessageTimeZone(runtime({ timeZone: "UTC" }), message("Asia/Tokyo")),
		).toBe("Asia/Tokyo");
		expect(
			resolveMessageTimeZone(runtime({ timeZone: "Europe/Paris" }), message()),
		).toBe("Europe/Paris");
		expect(resolveMessageTimeZone(runtime(), message())).toBe(hostTimeZone);
	});
});
