// @vitest-environment jsdom
import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { FlaminaGuideCard } from "./FlaminaGuide";

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

describe("FlaminaGuideCard", () => {
  it("explains provider impact on character behavior", () => {
    const tree = TestRenderer.create(
      React.createElement(FlaminaGuideCard, { topic: "provider" }),
    );

    const renderedText = textOf(tree.root);

    expect(renderedText).toContain("reasons");
    expect(renderedText).toContain("latency");
    expect(renderedText).toContain("output quality");
  });

  it("explains rpc impact on external capabilities", () => {
    const tree = TestRenderer.create(
      React.createElement(FlaminaGuideCard, { topic: "rpc" }),
    );

    const renderedText = textOf(tree.root);

    expect(renderedText).toContain("wallets");
    expect(renderedText).toContain("chains");
    expect(renderedText).toContain("external execution");
  });

  it("explains permissions impact on local access", () => {
    const tree = TestRenderer.create(
      React.createElement(FlaminaGuideCard, { topic: "permissions" }),
    );

    const renderedText = textOf(tree.root);

    expect(renderedText).toContain("see");
    expect(renderedText).toContain("control");
    expect(renderedText).toContain("locally");
  });

  it("explains voice impact on presentation", () => {
    const tree = TestRenderer.create(
      React.createElement(FlaminaGuideCard, { topic: "voice" }),
    );

    const renderedText = textOf(tree.root);

    expect(renderedText).toContain("sounds");
    expect(renderedText).toContain("spoken interactions");
    expect(renderedText).toContain("saved");
  });
});
