/// <reference path="./react-test-renderer-module.ts" />

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
