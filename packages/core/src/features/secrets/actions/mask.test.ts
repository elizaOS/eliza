import { describe, expect, it } from "vitest";
import { maskSecretValue } from "./mask";

/**
 * Tests for the secret-display mask (#10317 credential bridge / #8801, #9943).
 * `maskSecretValue` decides exactly how much of a secret is shown when a value
 * is surfaced (logs, UI, the credential bridge). A bug here leaks the secret,
 * so the invariants are pinned: short secrets are fully hidden, only the
 * first/last 4 chars of a long secret show, the middle is never exposed, and
 * the mask is capped so the length isn't revealed.
 */
describe("maskSecretValue", () => {
	it("fully masks secrets of 8 characters or fewer", () => {
		expect(maskSecretValue("")).toBe("****");
		expect(maskSecretValue("a")).toBe("****");
		expect(maskSecretValue("12345678")).toBe("****");
	});

	it("shows only the first and last 4 characters of a longer secret", () => {
		expect(maskSecretValue("123456789")).toBe("1234*6789");
		const masked = maskSecretValue("sk-abcdefghIJKLMNOP");
		expect(masked.startsWith("sk-a")).toBe(true);
		expect(masked.endsWith("MNOP")).toBe(true);
	});

	it("never exposes the middle of the secret", () => {
		const masked = maskSecretValue("AKIASECRETMIDDLETAIL");
		expect(masked).toBe("AKIA************TAIL");
		expect(masked).not.toContain("SECRETMIDDLE");
	});

	it("caps the mask at 20 stars so the true length is not revealed", () => {
		const masked = maskSecretValue("x".repeat(100));
		expect(masked).toHaveLength(28); // 4 + 20 + 4
		expect((masked.match(/\*/g) ?? []).length).toBe(20);
		expect(masked.startsWith("xxxx")).toBe(true);
		expect(masked.endsWith("xxxx")).toBe(true);
	});
});
