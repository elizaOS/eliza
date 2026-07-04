/**
 * Unit tests for owner-user-id extraction and parsing from settings
 * (`extractDiscordOwnerUserIds`, `parseDiscordOwnerUserIds`). Pure-function
 * assertions.
 */
import { describe, expect, it } from "vitest";
import {
	extractDiscordOwnerUserIds,
	parseDiscordOwnerUserIds,
} from "../identity.ts";

/**
 * Owner-id resolution decides who the Discord bot treats as its owner — a
 * security-sensitive grant. Snowflakes must match Discord's 15-20 digit shape
 * (anything else is rejected, never coerced), extraction must dedupe across the
 * direct owner / team owner / team members shapes (Array OR discord.js
 * Collection), and parse must tolerate JSON-string or array config without
 * letting a malformed id through.
 */

const SNOWFLAKE_A = "123456789012345678";
const SNOWFLAKE_B = "234567890123456789";

describe("extractDiscordOwnerUserIds", () => {
	it("reads the direct application owner", () => {
		expect(extractDiscordOwnerUserIds({ owner: { id: SNOWFLAKE_A } })).toEqual([
			SNOWFLAKE_A,
		]);
	});

	it("collects + dedupes team owner and members", () => {
		const application = {
			owner: { id: SNOWFLAKE_A },
			team: {
				ownerId: SNOWFLAKE_A, // duplicate of direct owner
				members: [{ user: { id: SNOWFLAKE_B } }],
			},
		};
		const ids = extractDiscordOwnerUserIds(application);
		expect(ids.sort()).toEqual([SNOWFLAKE_A, SNOWFLAKE_B].sort());
	});

	it("handles a discord.js Collection (Map of [key, member])", () => {
		const members = new Map([["k", { user: { id: SNOWFLAKE_B } }]]);
		expect(extractDiscordOwnerUserIds({ team: { members } })).toEqual([
			SNOWFLAKE_B,
		]);
	});

	it("returns [] for non-objects", () => {
		expect(extractDiscordOwnerUserIds(null)).toEqual([]);
		expect(extractDiscordOwnerUserIds("nope")).toEqual([]);
	});
});

describe("parseDiscordOwnerUserIds", () => {
	it("accepts an array or a JSON string of snowflakes", () => {
		expect(parseDiscordOwnerUserIds([SNOWFLAKE_A, SNOWFLAKE_B])).toEqual([
			SNOWFLAKE_A,
			SNOWFLAKE_B,
		]);
		expect(parseDiscordOwnerUserIds(JSON.stringify([SNOWFLAKE_A]))).toEqual([
			SNOWFLAKE_A,
		]);
	});

	it("drops malformed ids and tolerates junk input", () => {
		expect(
			parseDiscordOwnerUserIds([SNOWFLAKE_A, "12", "not-a-number"]),
		).toEqual([SNOWFLAKE_A]);
		expect(parseDiscordOwnerUserIds("not json")).toEqual([]);
		expect(parseDiscordOwnerUserIds("")).toEqual([]);
		expect(parseDiscordOwnerUserIds(42)).toEqual([]);
	});
});
