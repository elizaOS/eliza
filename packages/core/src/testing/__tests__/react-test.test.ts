import { describe, expect, it, vi } from "vitest";

vi.mock("react-test-renderer", () => ({
	act: (fn: () => unknown) => fn(),
}));

import {
	findButtonByText,
	flush,
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

	it("trims surrounding whitespace from the joined text", () => {
		expect(text(node("div", ["  padded  "]))).toBe("padded");
	});

	it("returns an empty string when only elements are children", () => {
		expect(text(node("div", [node("span", [])]))).toBe("");
	});
});

describe("textOf", () => {
	it("recursively extracts all text", () => {
		const tree = node("div", ["a", node("span", ["b", node("b", ["c"])])]);
		expect(textOf(tree)).toBe("abc");
	});

	it("keeps interleaved document order across nesting levels", () => {
		const tree = node("div", [
			"x",
			node("span", ["y"]),
			"z",
			node("section", [node("b", ["w"])]),
		]);
		expect(textOf(tree)).toBe("xyzw");
	});

	it("preserves internal whitespace instead of trimming like text", () => {
		const tree = node("div", [" a ", node("b", [" b "])]);
		expect(textOf(tree)).toBe(" a  b ");
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

	it("returns the first matching button when several match", () => {
		const first = node("button", ["Save"]);
		const second = node("button", ["Save"]);
		const root = {
			type: "div",
			children: [],
			findAll: (pred: (n: ReactTestInstance) => boolean) =>
				[first, second].filter(pred),
		} as never;
		expect(findButtonByText(root, "Save")).toBe(first);
	});

	it("matches labels after trimming button text", () => {
		const target = node("button", ["  Save  "]);
		const root = {
			type: "div",
			children: [],
			findAll: (pred: (n: ReactTestInstance) => boolean) =>
				[target].filter(pred),
		} as never;
		expect(findButtonByText(root, "Save")).toBe(target);
	});

	it("never matches non-button nodes carrying the same label", () => {
		const decoy = node("div", ["Save"]);
		const target = node("button", ["Save"]);
		const root = {
			type: "div",
			children: [],
			findAll: (pred: (n: ReactTestInstance) => boolean) =>
				[decoy, target].filter(pred),
		} as never;
		expect(findButtonByText(root, "Save")).toBe(target);
	});
});

describe("flush", () => {
	it("settles microtasks queued before it resolves", async () => {
		const order: string[] = [];
		Promise.resolve().then(() => order.push("queued"));
		await flush();
		expect(order).toEqual(["queued"]);
	});
});
