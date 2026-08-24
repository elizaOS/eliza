import { describe, expect, it } from "vitest";
import { claimsStrictRelease } from "./release-policy.ts";

describe("claimsStrictRelease", () => {
	it("fails closed on non-object input", () => {
		expect(claimsStrictRelease(null)).toBe(true);
		expect(claimsStrictRelease(undefined)).toBe(true);
		expect(claimsStrictRelease("x")).toBe(true);
	});

	it("accepts default-eligible manifests", () => {
		expect(claimsStrictRelease({ defaultEligible: true })).toBe(true);
	});

	it("classifies by provenance release state", () => {
		expect(claimsStrictRelease({ provenance: { releaseState: "final" } })).toBe(
			true,
		);
		expect(
			claimsStrictRelease({ provenance: { releaseState: "base-v1" } }),
		).toBe(true);
		expect(
			claimsStrictRelease({ provenance: { releaseState: "experimental" } }),
		).toBe(false);
	});

	it("treats staging versions as non-strict only when allowed", () => {
		const staged = { version: "1.2.3-candidate" };
		expect(claimsStrictRelease(staged)).toBe(true);
		expect(claimsStrictRelease(staged, { allowVersionStaging: true })).toBe(
			false,
		);
	});

	it("recognizes staging tokens in prerelease", () => {
		expect(
			claimsStrictRelease(
				{ version: "1.0.0-dev.1" },
				{ allowVersionStaging: true },
			),
		).toBe(false);
		expect(
			claimsStrictRelease(
				{ version: "1.0.0-local" },
				{ allowVersionStaging: true },
			),
		).toBe(false);
		expect(
			claimsStrictRelease(
				{ version: "1.0.0-rc.1" },
				{ allowVersionStaging: true },
			),
		).toBe(true);
	});
});
