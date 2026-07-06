/**
 * Unit tests for Discord message allowlist policy defaults. This file exercises
 * the exported synchronous helper directly so the fallback policy stays aligned
 * with the live message manager's pairing-default behavior.
 */
import { describe, expect, it } from "vitest";
import { validateMessageAllowed } from "../allowlist";

const author = {
	id: "1234567890",
	username: "alice",
	discriminator: "0001",
} as never;

describe("validateMessageAllowed DM policy", () => {
	it("defaults direct messages to pairing and denies without an explicit allow", () => {
		const result = validateMessageAllowed({
			accountConfig: {},
			isDirectMessage: true,
			isGroupDm: false,
			channelId: "dm-1",
			author,
		});

		expect(result).toEqual({
			allowed: false,
			reason: "DM pairing required",
		});
	});

	it("lets a static allowlist bypass pairing", () => {
		const result = validateMessageAllowed({
			accountConfig: { dm: { policy: "pairing", allowFrom: ["1234567890"] } },
			isDirectMessage: true,
			isGroupDm: false,
			channelId: "dm-1",
			author,
		});

		expect(result).toEqual({ allowed: true });
	});
});
