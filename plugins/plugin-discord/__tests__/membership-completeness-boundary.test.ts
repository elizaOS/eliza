/**
 * Tests membership completeness when the Discord member cache
 * temporarily exceeds the gateway member count. Discord.js evicts
 * departed members asynchronously, so a cache overshoot must classify
 * as unavailable — a complete roster derived from a cache larger than
 * memberCount would assert a departed member as present. Deterministic
 * harness: the pure classification function is called directly.
 */

import { describe, expect, it } from "vitest";
import { discordMembershipCompletenessForGuild } from "../membership";

describe("completeness cache-overshoot boundary (#24365)", () => {
	it("reports unavailable when the member cache holds MORE entries than memberCount", () => {
		const outcome = discordMembershipCompletenessForGuild({
			memberCount: 5,
			cachedMemberCount: 6,
		});
		expect(outcome.kind).toBe("unavailable");
	});

	it("keeps the unavailable reason explicit about the overshoot", () => {
		const outcome = discordMembershipCompletenessForGuild({
			memberCount: 5,
			cachedMemberCount: 6,
		});
		if (outcome.kind !== "unavailable") {
			throw new Error("expected unavailable");
		}
		expect(outcome.reason).toBe("member_cache_partial:6/5");
	});

	it("complete still requires exact equality (cache one BELOW memberCount)", () => {
		const outcome = discordMembershipCompletenessForGuild({
			memberCount: 6,
			cachedMemberCount: 5,
		});
		expect(outcome.kind).toBe("unavailable");
	});
});
