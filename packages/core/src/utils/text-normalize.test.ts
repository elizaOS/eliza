import { describe, expect, it } from "vitest";
import { flattenTextValues, toMultilineText } from "./text-normalize";

describe("flattenTextValues", () => {
	it("flattens strings", () => {
		expect(flattenTextValues("hello")).toEqual(["hello"]);
		expect(flattenTextValues("  hello  ")).toEqual(["hello"]);
	});

	it("drops empty/nullish values", () => {
		expect(flattenTextValues("")).toEqual([]);
		expect(flattenTextValues(null)).toEqual([]);
		expect(flattenTextValues(undefined)).toEqual([]);
		expect(flattenTextValues("   ")).toEqual([]);
	});

	it("flattens arrays", () => {
		expect(flattenTextValues(["a", "b", "c"])).toEqual(["a", "b", "c"]);
		expect(flattenTextValues(["a", "", "c"])).toEqual(["a", "c"]);
	});

	it("flattens nested arrays", () => {
		expect(flattenTextValues(["a", ["b", "c"], "d"])).toEqual(["a", "b", "c", "d"]);
	});

	it("flattens objects into key: value fragments", () => {
		expect(flattenTextValues({ name: "Alice", age: 30 })).toEqual(["name: Alice", "age: 30"]);
	});

	it("flattens nested objects", () => {
		const result = flattenTextValues({ user: { name: "Alice", age: 30 } });
		expect(result).toEqual(["user: name: Alice, age: 30"]);
	});

	it("drops empty object values", () => {
		expect(flattenTextValues({ a: "hello", b: null, c: undefined, d: "" })).toEqual(["a: hello"]);
	});

	it("handles numbers and booleans", () => {
		expect(flattenTextValues(42)).toEqual(["42"]);
		expect(flattenTextValues(true)).toEqual(["true"]);
		expect(flattenTextValues(false)).toEqual(["false"]);
	});

	it("handles Dates", () => {
		const date = new Date("2024-01-15T12:00:00.000Z");
		expect(flattenTextValues(date)).toEqual(["2024-01-15T12:00:00.000Z"]);
	});

	it("handles arrays with holes", () => {
		const arr = ["a", , "c"];
		expect(flattenTextValues(arr)).toEqual(["a", "c"]);
	});

	it("handles mixed nested values", () => {
		const result = flattenTextValues({
			messages: [
				{ role: "user", content: "hello" },
				{ role: "bot", content: "hi" },
			],
		});
		expect(result).toEqual(["messages: role: user, content: hello, role: bot, content: hi"]);
	});
});

describe("toMultilineText", () => {
	it("joins flattened values with newlines", () => {
		expect(toMultilineText({ a: "hello", b: "world" })).toBe("a: hello\nb: world");
	});

	it("handles empty objects", () => {
		expect(toMultilineText({})).toBe("");
	});

	it("handles arrays", () => {
		expect(toMultilineText(["a", "b", "c"])).toBe("a\nb\nc");
	});

	it("handles single string", () => {
		expect(toMultilineText("hello")).toBe("hello");
	});
});
