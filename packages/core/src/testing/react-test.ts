/// <reference path="./react-test-renderer-module.ts" />

/**
 * Assertion helpers over `react-test-renderer` trees: recursive text extraction
 * (`text` / `textOf`), a button-by-label finder, and an `act`-based microtask
 * `flush`. Pairs with the ambient `react-test-renderer` declaration in the
 * sibling module.
 */
import { act } from "react-test-renderer";

export type ReactTestChild = string | ReactTestInstance;

export interface ReactTestInstance {
	readonly type: string | object;
	readonly children: readonly ReactTestChild[];
	findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
}

export function text(node: ReactTestInstance): string {
	return node.children
		.map((child) => (typeof child === "string" ? child : ""))
		.join("")
		.trim();
}

export function textOf(node: ReactTestInstance): string {
	return node.children
		.map((child) => (typeof child === "string" ? child : textOf(child)))
		.join("");
}

export function findButtonByText(
	root: ReactTestInstance,
	label: string,
): ReactTestInstance {
	const matches = root.findAll(
		(node) => node.type === "button" && text(node) === label,
	);
	if (!matches[0]) {
		throw new Error(`Button "${label}" not found`);
	}
	return matches[0];
}

export async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}
