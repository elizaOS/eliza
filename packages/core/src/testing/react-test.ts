/**
 * Shared React test-renderer helpers.
 *
 * Consolidates utility functions duplicated across 40+ component test files:
 * - text / textOf — extract text content from rendered nodes
 * - findButtonByText — locate buttons by label
 * - flush — flush pending React effects via act()
 */

import type TestRenderer from "react-test-renderer";
import { act } from "react-test-renderer";

/**
 * Extract direct text children from a rendered node (shallow).
 * Only concatenates immediate string children — does not recurse.
 */
export function text(node: TestRenderer.ReactTestInstance): string {
	return node.children
		.map((child) => (typeof child === "string" ? child : ""))
		.join("")
		.trim();
}

/**
 * Extract all text content from a rendered node (recursive).
 * Traverses the full subtree to collect all string children.
 */
export function textOf(node: TestRenderer.ReactTestInstance): string {
	return node.children
		.map((child) => (typeof child === "string" ? child : textOf(child)))
		.join("");
}

/**
 * Find a button element by its text label.
 * Throws if no matching button is found.
 */
export function findButtonByText(
	root: TestRenderer.ReactTestInstance,
	label: string,
): TestRenderer.ReactTestInstance {
	const matches = root.findAll(
		(node) => node.type === "button" && text(node) === label,
	);
	if (!matches[0]) {
		throw new Error(`Button "${label}" not found`);
	}
	return matches[0];
}

/**
 * Flush pending React effects by awaiting a microtask inside act().
 * Use after state updates to let effects and re-renders settle.
 */
export async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}
