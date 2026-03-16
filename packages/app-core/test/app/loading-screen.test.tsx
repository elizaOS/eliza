import { AvatarLoader } from "@elizaos/app-core/components/AvatarLoader";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it } from "vitest";

function renderedText(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType("div")
    .map((node) => node.children.join(""))
    .join("\n");
}

describe("AvatarLoader", () => {
  it("shows default label", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AvatarLoader));
    });
    if (!tree) throw new Error("failed to render");

    expect(renderedText(tree)).toContain("Initializing entity");
  });

  it("shows custom label", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(AvatarLoader, { label: "Starting systems" }),
      );
    });
    if (!tree) throw new Error("failed to render");

    expect(renderedText(tree)).toContain("Starting systems");
  });

  it("shows LOADING text", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(AvatarLoader));
    });
    if (!tree) throw new Error("failed to render");

    expect(renderedText(tree)).toContain("LOADING");
  });
});
