/**
 * Covers the core `detectPii` classes and their validation primitives —
 * Luhn/card-brand, SSN, IPv4 range, IBAN mod-97 — plus span overlap resolution,
 * source ordering, and `disabledKinds`. Deterministic pattern/validator checks.
 */

import { describe, expect, it } from "vitest";
import {
	cardBrand,
	detectPii,
	ibanValid,
	ipv4Valid,
	luhnValid,
	PII_DETECTORS,
	ssnValid,
} from "./pii-detectors";

/** Pull the set of detected `kind`s for a quick membership assertion. */
function kinds(text: string): string[] {
	return detectPii(text).map((m) => m.kind);
}
function valuesOf(text: string, kind: string): string[] {
	return detectPii(text)
		.filter((m) => m.kind === kind)
		.map((m) => m.value);
}

describe("validation primitives", () => {
	describe("luhnValid", () => {
		it("accepts known-good card numbers", () => {
			for (const n of [
				"4242424242424242", // Visa test
				"4111111111111111", // Visa
				"5555555555554444", // Mastercard
				"5105105105105100", // Mastercard
				"378282246310005", // Amex (15)
				"371449635398431", // Amex
				"6011111111111117", // Discover
				"3530111333300000", // JCB
				"30569309025904", // Diners (14)
			]) {
				expect(luhnValid(n)).toBe(true);
			}
		});
		it("rejects off-by-one / non-digit / empty", () => {
			expect(luhnValid("4242424242424241")).toBe(false);
			expect(luhnValid("1234567890123456")).toBe(false);
			expect(luhnValid("")).toBe(false);
			expect(luhnValid("4242-4242")).toBe(false); // contains non-digits
		});
	});

	describe("cardBrand", () => {
		it("classifies the major brands", () => {
			expect(cardBrand("4242424242424242")).toBe("visa");
			expect(cardBrand("5555555555554444")).toBe("mastercard");
			expect(cardBrand("2223003122003222")).toBe("mastercard"); // 2-series
			expect(cardBrand("378282246310005")).toBe("amex");
			expect(cardBrand("6011111111111117")).toBe("discover");
			expect(cardBrand("3530111333300000")).toBe("jcb");
			expect(cardBrand("30569309025904")).toBe("diners");
			expect(cardBrand("9999999999999999")).toBeNull();
		});
	});

	describe("ssnValid", () => {
		it("accepts allocatable SSNs and rejects reserved ranges", () => {
			expect(ssnValid("123-45-6789")).toBe(true);
			expect(ssnValid("001 01 0001")).toBe(true);
			expect(ssnValid("000-12-3456")).toBe(false); // area 000
			expect(ssnValid("666-12-3456")).toBe(false); // area 666
			expect(ssnValid("900-12-3456")).toBe(false); // area >= 900
			expect(ssnValid("123-00-6789")).toBe(false); // group 00
			expect(ssnValid("123-45-0000")).toBe(false); // serial 0000
		});
	});

	describe("ipv4Valid", () => {
		it("range-checks octets", () => {
			expect(ipv4Valid("192.168.1.1")).toBe(true);
			expect(ipv4Valid("8.8.8.8")).toBe(true);
			expect(ipv4Valid("255.255.255.255")).toBe(true);
			expect(ipv4Valid("256.1.2.3")).toBe(false);
			expect(ipv4Valid("1.2.3")).toBe(false);
			expect(ipv4Valid("999.999.999.999")).toBe(false);
		});
	});

	describe("ibanValid", () => {
		it("mod-97 validates real IBANs and rejects corrupted ones", () => {
			expect(ibanValid("DE89370400440532013000")).toBe(true);
			expect(ibanValid("GB29 NWBK 6016 1331 9268 19")).toBe(true);
			expect(ibanValid("FR1420041010050500013M02606")).toBe(true);
			expect(ibanValid("DE89370400440532013001")).toBe(false); // bad check
			expect(ibanValid("XX00NOTANIBAN")).toBe(false);
		});
	});
});

describe("detectPii — credit cards", () => {
	it("detects Luhn+brand-valid cards with and without separators", () => {
		expect(valuesOf("pay with 4242424242424242 now", "credit-card")).toEqual([
			"4242424242424242",
		]);
		expect(valuesOf("card 4242 4242 4242 4242 ok", "credit-card")).toEqual([
			"4242 4242 4242 4242",
		]);
		expect(valuesOf("amex 3782-822463-10005", "credit-card")).toEqual([
			"3782-822463-10005",
		]);
	});
	it("rejects Luhn-failing and brand-less 16-digit runs (no false positive)", () => {
		expect(kinds("order id 1234567890123456")).not.toContain("credit-card");
		expect(kinds("ref 9999000011112222")).not.toContain("credit-card");
		// A 16-digit Luhn-valid number with no known brand prefix is not a card.
		expect(kinds("token 8888888888888888")).not.toContain("credit-card");
	});
});

describe("detectPii — other classes", () => {
	it("emails", () => {
		expect(
			valuesOf("reach me at jane.doe+x@example.co.uk please", "email"),
		).toEqual(["jane.doe+x@example.co.uk"]);
		expect(kinds("not-an-email @ nope")).not.toContain("email");
	});
	it("SSN (validated)", () => {
		expect(valuesOf("ssn 123-45-6789", "ssn")).toEqual(["123-45-6789"]);
		expect(kinds("ssn 000-45-6789")).not.toContain("ssn");
	});
	it("IBAN (validated)", () => {
		expect(kinds("iban GB29 NWBK 6016 1331 9268 19")).toContain("iban");
		expect(kinds("iban DE89370400440532013001")).not.toContain("iban");
	});
	it("JWT", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		expect(valuesOf(`token=${jwt}`, "jwt")).toEqual([jwt]);
	});
	it("cloud + provider keys", () => {
		expect(kinds("AKIAIOSFODNN7EXAMPLE")).toContain("aws-access-key");
		expect(kinds("sk_live_4eC39HqLyjWDarjtT1zdp7dc")).toContain("stripe-key");
		expect(kinds("AIzaSyA-1234567890abcdefghijklmnopqrstu")).toContain(
			"google-api-key",
		);
		expect(kinds("ghp_1234567890abcdefghijklmnopqrstuvwxyz")).toContain(
			"github-token",
		);
		expect(kinds("xoxb-12345-67890-abcdefghij")).toContain("slack-token");
	});
	it("PEM private key block", () => {
		const pem =
			"-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIQ\n-----END EC PRIVATE KEY-----";
		expect(valuesOf(pem, "private-key")).toEqual([pem]);
	});
	it("IPv4 (range validated) + MAC", () => {
		expect(valuesOf("host 192.168.0.42 up", "ipv4")).toEqual(["192.168.0.42"]);
		expect(kinds("version 256.0.0.1")).not.toContain("ipv4");
		expect(kinds("mac 01:23:45:67:89:ab")).toContain("mac-address");
	});
	it("phone numbers (but not bare digit runs)", () => {
		expect(kinds("call +1 (415) 555-2671")).toContain("phone");
		expect(kinds("us 415-555-2671")).toContain("phone");
		expect(kinds("intl +442071838750")).toContain("phone");
		// A bare 10-digit run (order id / timestamp) is NOT a phone number.
		expect(kinds("order 4155552671 shipped")).not.toContain("phone");
		expect(kinds("ts 1234567890")).not.toContain("phone");
	});
	it("0x hex secret (64 nibble)", () => {
		const k = `0x${"a".repeat(64)}`;
		expect(valuesOf(`pk=${k}`, "hex-secret")).toEqual([k]);
	});
});

describe("detectPii — overlap + structure", () => {
	it("does not double-match a card span as a phone span", () => {
		const found = detectPii("4242 4242 4242 4242");
		expect(found).toHaveLength(1);
		expect(found[0]?.kind).toBe("credit-card");
	});
	it("returns spans in source order", () => {
		const text = "mail a@b.com card 4242424242424242 ip 10.0.0.1";
		const ks = detectPii(text).map((m) => m.kind);
		expect(ks).toEqual(["email", "credit-card", "ipv4"]);
	});
	it("disabledKinds skips a class", () => {
		expect(
			detectPii("a@b.com 192.168.1.1", {
				disabledKinds: new Set(["ipv4"]),
			}).map((m) => m.kind),
		).toEqual(["email"]);
	});
	it("every registered detector has a global pattern", () => {
		for (const d of PII_DETECTORS) expect(d.pattern.flags).toContain("g");
	});
});
