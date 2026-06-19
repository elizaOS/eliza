/** Small `react-test-renderer` helpers shared by component tests. */

import type TestRenderer from "react-test-renderer";
import { act } from "react-test-renderer";

/** Returns the direct string children for a rendered node. */
export function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

/** Returns the recursive string content for a rendered node. */
export function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

/** Finds a button by label. */
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

/** Flushes pending React effects. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
