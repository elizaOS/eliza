/**
 * Unit tests for Discord owner alias extraction, team-admin extraction, and
 * owner-id setting parsing. These pure helpers decide whether an inbound
 * Discord user is collapsed to the canonical owner entity or kept auditable as
 * their own connector identity.
 */
import { describe, expect, it } from "vitest";
import {
	extractDiscordOwnerUserIds,
	extractDiscordTeamAdminUserIds,
	parseDiscordOwnerUserIds,
} from "../identity.ts";

/**
 * Owner-id resolution decides who the Discord bot treats as its owner — a
 * security-sensitive grant. Snowflakes must match Discord's 15-20 digit shape
 * (anything else is rejected, never coerced). Team members are connector-admin
 * candidates, but they must never be owner aliases because owner aliasing also
 * rewrites message attribution to the canonical owner entity.
 */

const SNOWFLAKE_A = "123456789012345678";
const SNOWFLAKE_B = "234567890123456789";

describe("extractDiscordOwnerUserIds", () => {
	it("reads the direct application owner", () => {
		expect(extractDiscordOwnerUserIds({ owner: { id: SNOWFLAKE_A } })).toEqual([
			SNOWFLAKE_A,
		]);
	});

	it("collects + dedupes direct owner and team owner only", () => {
		const application = {
			owner: { id: SNOWFLAKE_A },
			team: {
				ownerId: SNOWFLAKE_A, // duplicate of direct owner
				members: [{ user: { id: SNOWFLAKE_B } }],
			},
		};
		const ids = extractDiscordOwnerUserIds(application);
		expect(ids).toEqual([SNOWFLAKE_A]);
	});

	it("reads a team-owned application's team owner as the owner alias", () => {
		expect(
			extractDiscordOwnerUserIds({
				team: {
					ownerId: SNOWFLAKE_A,
					members: [{ user: { id: SNOWFLAKE_B } }],
				},
			}),
		).toEqual([SNOWFLAKE_A]);
	});

	it("does not treat a discord.js team member Collection as owner aliases", () => {
		const members = new Map([["k", { user: { id: SNOWFLAKE_B } }]]);
		expect(extractDiscordOwnerUserIds({ team: { members } })).toEqual([]);
	});

	it("returns [] for non-objects", () => {
		expect(extractDiscordOwnerUserIds(null)).toEqual([]);
		expect(extractDiscordOwnerUserIds("nope")).toEqual([]);
	});
});

describe("extractDiscordTeamAdminUserIds", () => {
	it("collects team members from array-shaped application metadata", () => {
		expect(
			extractDiscordTeamAdminUserIds({
				team: { members: [{ user: { id: SNOWFLAKE_B } }] },
			}),
		).toEqual([SNOWFLAKE_B]);
	});

	it("handles a discord.js Collection (Map of [key, member])", () => {
		const members = new Map([["k", { user: { id: SNOWFLAKE_B } }]]);
		expect(extractDiscordTeamAdminUserIds({ team: { members } })).toEqual([
			SNOWFLAKE_B,
		]);
	});

	it("returns [] for non-objects", () => {
		expect(extractDiscordTeamAdminUserIds(null)).toEqual([]);
		expect(extractDiscordTeamAdminUserIds("nope")).toEqual([]);
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
