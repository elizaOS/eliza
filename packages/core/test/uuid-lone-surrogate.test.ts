import { describe, expect, it } from "vitest";
import { stringToUuid } from "../src/utils/string-to-uuid.ts";
import { validateUuid } from "../src/utils/uuid.ts";

describe("stringToUuid lone surrogates", () => {
	it("does not throw on a lone surrogate and matches the replacement char", () => {
		expect(stringToUuid("\uD83D")).toBe(stringToUuid("\uFFFD"));
		expect(validateUuid(stringToUuid("\uD83D"))).not.toBeNull();
	});

	it("does not throw on a lone low surrogate or a mixed string", () => {
		expect(stringToUuid("\uDE00")).toBe(stringToUuid("\uFFFD"));
		expect(stringToUuid("a\uD83Db")).toBe(stringToUuid("a\uFFFDb"));
	});

	it("keeps existing deterministic ids unchanged", () => {
		expect(stringToUuid("hello")).toBe("aaf4c61d-dcc5-08a2-9abe-de0f3b482cd9");
		expect(stringToUuid("")).toBe("da39a3ee-5e6b-0b0d-b255-bfef95601890");
	});
});
