import { describe, expect, it } from "vitest";
import {
	DiscordPermissionTiers,
	generateAllInviteUrls,
	generateInviteUrl,
	getPermissionValues,
	PERMISSIONS_ADMIN,
	PERMISSIONS_ADMIN_VOICE,
	PERMISSIONS_BASIC,
	PERMISSIONS_BASIC_VOICE,
	PERMISSIONS_MODERATOR,
	PERMISSIONS_MODERATOR_VOICE,
	REQUIRED_PERMISSIONS,
} from "../permissions";

// Discord permission bit constants used to assert tier composition.
// Bitwise math happens on the exported BigInt constants: JS `&` truncates
// to 32 bits, and tiers include bits up to 1n << 46n.
const KICK_MEMBERS = 1n << 1n;
const BAN_MEMBERS = 1n << 2n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;
const MANAGE_CHANNELS = 1n << 4n;

const hasBits = (value: bigint, bits: bigint): boolean =>
	(value & bits) === bits;

describe("DiscordPermissionTiers", () => {
	it("exposes six distinct non-zero tier values", () => {
		const values = Object.values(DiscordPermissionTiers);
		expect(values).toHaveLength(6);
		expect(new Set(values).size).toBe(6);
		for (const value of values) {
			expect(value).toBeGreaterThan(0);
		}
	});

	it("keeps BASIC a strict subset of MODERATOR and ADMIN", () => {
		expect(hasBits(PERMISSIONS_MODERATOR, PERMISSIONS_BASIC)).toBe(true);
		expect(hasBits(PERMISSIONS_ADMIN, PERMISSIONS_MODERATOR)).toBe(true);
		expect(PERMISSIONS_MODERATOR).not.toBe(PERMISSIONS_BASIC);
		expect(PERMISSIONS_ADMIN).not.toBe(PERMISSIONS_MODERATOR);
	});

	it("grants ADMIN moderation powers (kick, ban, channel management)", () => {
		expect(hasBits(PERMISSIONS_ADMIN, KICK_MEMBERS | BAN_MEMBERS)).toBe(true);
		expect(hasBits(PERMISSIONS_ADMIN, MANAGE_CHANNELS)).toBe(true);
		expect(hasBits(PERMISSIONS_MODERATOR, KICK_MEMBERS)).toBe(false);
	});

	it("adds voice bits to the voice tier variants", () => {
		expect(hasBits(PERMISSIONS_BASIC_VOICE, CONNECT | SPEAK)).toBe(true);
		expect(hasBits(PERMISSIONS_BASIC, CONNECT)).toBe(false);
		expect(hasBits(PERMISSIONS_MODERATOR_VOICE, PERMISSIONS_BASIC_VOICE)).toBe(
			true,
		);
		expect(hasBits(PERMISSIONS_ADMIN_VOICE, PERMISSIONS_MODERATOR_VOICE)).toBe(
			true,
		);
	});

	it("exports the moderator-voice set as the required permission floor", () => {
		expect(Number(REQUIRED_PERMISSIONS)).toBe(
			DiscordPermissionTiers.MODERATOR_VOICE,
		);
	});
});

describe("getPermissionValues", () => {
	it("mirrors the tier constants for all six tiers", () => {
		const values = getPermissionValues();
		expect(values.basic).toBe(DiscordPermissionTiers.BASIC);
		expect(values.basicVoice).toBe(DiscordPermissionTiers.BASIC_VOICE);
		expect(values.moderator).toBe(DiscordPermissionTiers.MODERATOR);
		expect(values.moderatorVoice).toBe(DiscordPermissionTiers.MODERATOR_VOICE);
		expect(values.admin).toBe(DiscordPermissionTiers.ADMIN);
		expect(values.adminVoice).toBe(DiscordPermissionTiers.ADMIN_VOICE);
	});
});

describe("generateInviteUrl", () => {
	it("builds the OAuth authorize URL with bot + application.commands scopes", () => {
		const url = generateInviteUrl("1234567890");
		expect(url.startsWith("https://discord.com/api/oauth2/authorize?")).toBe(
			true,
		);
		expect(url).toContain("client_id=1234567890");
		expect(url).toContain("scope=bot%20applications.commands");
	});

	it("defaults to the MODERATOR_VOICE permission set", () => {
		expect(generateInviteUrl("1")).toContain(
			`permissions=${DiscordPermissionTiers.MODERATOR_VOICE}`,
		);
	});

	it("encodes the requested tier's permission bitfield", () => {
		expect(generateInviteUrl("1", "BASIC")).toContain(
			`permissions=${DiscordPermissionTiers.BASIC}`,
		);
		expect(generateInviteUrl("1", "ADMIN")).toContain(
			`permissions=${DiscordPermissionTiers.ADMIN}`,
		);
	});

	it("throws a RangeError for an unknown tier instead of emitting permissions=undefined", () => {
		// A typo'd or stale tier string must fail loudly: emitting
		// `permissions=undefined` would produce an invite URL that grants the
		// bot no (or an unintended) permission set while looking plausible.
		expect(() => generateInviteUrl("1", "SUPERUSER" as never)).toThrow(
			RangeError,
		);
		expect(() => generateInviteUrl("1", "" as never)).toThrow(RangeError);
	});
});

describe("generateAllInviteUrls", () => {
	it("emits one URL per tier with the same bitfields as getPermissionValues", () => {
		const urls = generateAllInviteUrls("app-1");
		const values = getPermissionValues();
		expect(Object.keys(urls).sort()).toEqual(Object.keys(values).sort());
		for (const tier of Object.keys(values) as Array<keyof typeof values>) {
			expect(urls[tier]).toContain(`permissions=${values[tier]}`);
		}
	});

	it("always references the same application id", () => {
		const urls = generateAllInviteUrls("app-42");
		for (const url of Object.values(urls)) {
			expect(url).toContain("client_id=app-42");
		}
	});
});
