import { describe, expect, it, vi } from "vitest";

vi.mock("react-test-renderer", () => ({
	act: (fn: () => unknown) => fn(),
}));

import {
	findButtonByText,
	type ReactTestInstance,
	text,
	textOf,
} from "../react-test.ts";

function node(
	type: string | object,
	children: ReactTestInstance["children"],
): ReactTestInstance {
	return { type, children, findAll: vi.fn(() => []) } as never;
}

describe("text", () => {
	it("joins direct string children", () => {
		expect(text(node("div", ["hi ", "there"]))).toBe("hi there");
	});

	it("ignores non-string children", () => {
		expect(text(node("div", ["a", node("span", ["b"])]))).toBe("a");
	});
});

describe("textOf", () => {
	it("recursively extracts all text", () => {
		const tree = node("div", ["a", node("span", ["b", node("b", ["c"])])]);
		expect(textOf(tree)).toBe("abc");
	});
});

describe("findButtonByText", () => {
	it("finds a button whose text matches", () => {
		const target = node("button", ["Save"]);
		const root = {
			type: "div",
			children: [],
			findAll: (pred: (n: ReactTestInstance) => boolean) =>
				[target].filter(pred),
		} as never;
		expect(findButtonByText(root, "Save")).toBe(target);
	});

	it("throws when the button is missing", () => {
		const root = {
			type: "div",
			children: [],
			findAll: () => [],
		} as never;
		expect(() => findButtonByText(root, "Nope")).toThrow(
			'Button "Nope" not found',
		);
	});
});
