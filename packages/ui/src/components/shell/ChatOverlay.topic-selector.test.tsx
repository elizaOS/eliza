/** Verifies topic lookup uses exact dataset comparison for selector metacharacters. */
import { describe, expect, it } from "vitest";
import { findTopicElement } from "./topic-element";

describe("findTopicElement", () => {
  it("matches exact adversarial topic values without CSS escaping", () => {
    const topic = String.raw`topic"] > * { color: red } \\`;
    const target = {
      dataset: { topic },
    } as unknown as HTMLElement;
    const root = {
      querySelectorAll: () => [target],
    } as unknown as ParentNode;

    expect(findTopicElement(root, topic)).toBe(target);
    expect(findTopicElement(root, 'topic"]')).toBeUndefined();
  });
});
