/** Persisted IDs captured from the pre-consolidation SHA-1 implementation. */
import { describe, expect, it } from "vitest";
import { stringToUuid } from "./utils";

describe("historical deterministic identity", () => {
	it.each([
		{
			value: "",
			id: "da39a3ee-5e6b-0b0d-b255-bfef95601890",
		},
		{
			value: "Eliza",
			id: "b850bc30-45f8-0041-a00a-83df46d8555d",
		},
		{
			value: "用户🌍",
			id: "3c500121-7757-0663-805a-eb19f255f0d7",
		},
		{
			value: "space / % ? &",
			id: "490f1b5d-9f38-07b2-badf-edee74c60c5e",
		},
		{
			value: "é",
			id: "e1f229ed-4c31-0e46-97ca-57028526a3ae",
		},
		{
			value: 0,
			id: "b6589fc6-ab0d-082c-b120-99d1c2d40ab9",
		},
		{
			value: -42,
			id: "2f4399f4-078e-00f2-85c3-0dd0f3a4770a",
		},
		{
			value: 3.14,
			id: "983b3477-1fb7-085d-84c9-603559c9e46f",
		},
		{
			value: "123e4567-e89b-12d3-a456-426614174000",
			id: "123e4567-e89b-12d3-a456-426614174000",
		},
	])("preserves $value", ({ value, id }) => {
		expect(stringToUuid(value)).toBe(id);
	});
	it("retains rejection of invalid Unicode instead of changing stored identities", () => {
		expect(() => stringToUuid("\ud800")).toThrow(URIError);
	});
});
