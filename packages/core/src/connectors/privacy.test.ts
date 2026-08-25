/**
 * Unit coverage for privacy levels and comparison helpers in privacy.ts.
 *
 * Tests privacy levels scale ordering, privacyAtLeast hierarchy checks,
 * isPrivacyLevel type guard, and getAccountPrivacy fallback resolution.
 */

import { describe, expect, it } from "vitest";
import type { ConnectorAccount } from "./account-manager.js";
import {
	DEFAULT_PRIVACY_LEVEL,
	getAccountPrivacy,
	isPrivacyLevel,
	PRIVACY_LEVELS,
	privacyAtLeast,
} from "./privacy.js";

describe("privacy", () => {
	it("exports PRIVACY_LEVELS array with all canonical levels in ascending order", () => {
		expect(PRIVACY_LEVELS).toEqual([
			"owner_only",
			"team_visible",
			"semi_public",
			"public",
		]);
	});

	it("defines DEFAULT_PRIVACY_LEVEL as 'owner_only'", () => {
		expect(DEFAULT_PRIVACY_LEVEL).toBe("owner_only");
	});

	describe("privacyAtLeast", () => {
		it("returns true when actual rank meets or exceeds required rank", () => {
			expect(privacyAtLeast("public", "owner_only")).toBe(true);
			expect(privacyAtLeast("public", "public")).toBe(true);
			expect(privacyAtLeast("team_visible", "owner_only")).toBe(true);
			expect(privacyAtLeast("semi_public", "team_visible")).toBe(true);
			expect(privacyAtLeast("owner_only", "owner_only")).toBe(true);
		});

		it("returns false when actual rank is less permissive than required", () => {
			expect(privacyAtLeast("owner_only", "team_visible")).toBe(false);
			expect(privacyAtLeast("team_visible", "semi_public")).toBe(false);
			expect(privacyAtLeast("semi_public", "public")).toBe(false);
			expect(privacyAtLeast("owner_only", "public")).toBe(false);
		});
	});

	describe("isPrivacyLevel", () => {
		it("validates canonical privacy levels", () => {
			for (const level of PRIVACY_LEVELS) {
				expect(isPrivacyLevel(level)).toBe(true);
			}
		});

		it("rejects non-canonical strings and invalid types", () => {
			expect(isPrivacyLevel("private")).toBe(false);
			expect(isPrivacyLevel("OWNER_ONLY")).toBe(false);
			expect(isPrivacyLevel("")).toBe(false);
			expect(isPrivacyLevel(123)).toBe(false);
			expect(isPrivacyLevel(null)).toBe(false);
			expect(isPrivacyLevel(undefined)).toBe(false);
		});
	});

	describe("getAccountPrivacy", () => {
		it("extracts valid privacy level from account metadata", () => {
			const account = {
				metadata: {
					privacy: "semi_public",
				},
			} as unknown as ConnectorAccount;

			expect(getAccountPrivacy(account)).toBe("semi_public");
		});

		it("falls back to DEFAULT_PRIVACY_LEVEL when metadata or privacy is missing", () => {
			expect(getAccountPrivacy({} as ConnectorAccount)).toBe("owner_only");
			expect(
				getAccountPrivacy({ metadata: {} } as unknown as ConnectorAccount),
			).toBe("owner_only");
			expect(
				getAccountPrivacy({
					metadata: { privacy: "invalid" },
				} as unknown as ConnectorAccount),
			).toBe("owner_only");
		});
	});
});
