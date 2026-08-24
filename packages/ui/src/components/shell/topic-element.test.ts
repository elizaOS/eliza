/** Verifies findTopicElement's dataset-exact topic lookup against real jsdom DOM. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { findTopicElement } from "./topic-element";

const el = (tag: string, topic?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (topic !== undefined) {
    node.setAttribute("data-topic", topic);
  }
  return node;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findTopicElement", () => {
  it("returns undefined when root is null", () => {
    expect(findTopicElement(null, "billing")).toBeUndefined();
  });

  it("returns undefined when the root has no data-topic descendants", () => {
    const root = document.createElement("div");
    root.append(el("span"), el("p"), el("button"));
    expect(findTopicElement(root, "billing")).toBeUndefined();
  });

  it("returns the element whose data-topic equals the requested topic", () => {
    const root = document.createElement("div");
    const match = el("button", "billing");
    root.append(el("span", "deployment"), match, el("p", "latency"));
    expect(findTopicElement(root, "billing")).toBe(match);
  });

  it("returns the first match in document order among duplicate topics", () => {
    const root = document.createElement("div");
    const first = el("button", "billing");
    const second = el("button", "billing");
    root.append(first, second);
    expect(findTopicElement(root, "billing")).toBe(first);
  });

  it("matches case-sensitively", () => {
    const root = document.createElement("div");
    root.append(el("span", "Billing"));
    expect(findTopicElement(root, "billing")).toBeUndefined();
  });

  it("does not trim whitespace on either side of the comparison", () => {
    const paddedRoot = document.createElement("div");
    const padded = el("span", " billing");
    paddedRoot.append(padded);
    expect(findTopicElement(paddedRoot, "billing")).toBeUndefined();
    expect(findTopicElement(paddedRoot, " billing")).toBe(padded);

    const trailingRoot = document.createElement("div");
    const trailing = el("span", "billing ");
    trailingRoot.append(trailing);
    expect(findTopicElement(trailingRoot, "billing ")).toBe(trailing);
  });

  it("matches an empty-string topic against an empty data-topic attribute", () => {
    const root = document.createElement("div");
    const empty = el("span", "");
    root.append(empty, el("p", "billing"));
    expect(findTopicElement(root, "")).toBe(empty);
  });

  it("ignores elements whose non-data-topic attributes or text equal the topic", () => {
    const root = document.createElement("div");
    const decoy = document.createElement("span");
    decoy.textContent = "billing";
    decoy.setAttribute("data-label", "billing");
    root.append(decoy);
    expect(findTopicElement(root, "billing")).toBeUndefined();
  });

  it("finds deeply nested matches", () => {
    const root = document.createElement("div");
    const section = document.createElement("section");
    const list = document.createElement("ul");
    const leaf = el("li", "deployment");
    list.append(leaf);
    section.append(list);
    root.append(section);
    expect(findTopicElement(root, "deployment")).toBe(leaf);
  });

  it("treats a selector-like topic as a literal dataset value, not a query", () => {
    const root = document.createElement("div");
    root.append(el("span", "deployment"));
    const injected = `x"], [data-topic="deployment"], [data-topic="`;
    expect(findTopicElement(root, injected)).toBeUndefined();
  });

  it("only searches inside the given subtree root", () => {
    const outer = document.createElement("div");
    const left = document.createElement("div");
    const right = document.createElement("div");
    const leftMatch = el("button", "billing");
    const rightMatch = el("button", "latency");
    left.append(leftMatch);
    right.append(rightMatch);
    outer.append(left, right);
    document.body.append(outer);
    expect(findTopicElement(left, "billing")).toBe(leftMatch);
    expect(findTopicElement(left, "latency")).toBeUndefined();
    expect(findTopicElement(right, "latency")).toBe(rightMatch);
  });

  it("accepts the document itself as the ParentNode root", () => {
    const match = el("button", "greeting");
    document.body.append(match);
    expect(findTopicElement(document, "greeting")).toBe(match);
  });
});
