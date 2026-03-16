import { SecretsView } from "@elizaos/app-core/components";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSecrets, mockUpdateSecrets } = vi.hoisted(() => ({
  mockGetSecrets: vi.fn(),
  mockUpdateSecrets: vi.fn(),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getSecrets: mockGetSecrets,
    updateSecrets: mockUpdateSecrets,
  },
}));

describe("SecretsView picker keyboard behavior", () => {
  beforeEach(() => {
    mockGetSecrets.mockReset();
    mockUpdateSecrets.mockReset();
    const storage = globalThis.localStorage;
    if (storage && typeof storage.clear === "function") {
      storage.clear();
    }
  });

  it("keeps picker open on Enter/Space and closes on Escape", async () => {
    mockGetSecrets.mockResolvedValue({
      secrets: [
        {
          key: "OPENAI_API_KEY",
          description: "OpenAI key",
          category: "ai-provider",
          sensitive: true,
          required: false,
          isSet: false,
          maskedValue: null,
          usedBy: [
            {
              pluginId: "openai",
              pluginName: "OpenAI",
              enabled: true,
            },
          ],
        },
      ],
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(SecretsView));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const addSecretButton = tree.root.find(
      (node) =>
        node.type === "button" &&
        node.props.children === "secretsview.AddSecret",
    );

    await act(async () => {
      addSecretButton.props.onClick();
    });

    expect(tree.root.findAllByProps({ role: "dialog" }).length).toBe(1);

    const dialog = tree.root.findByProps({ role: "dialog" });
    const preventDefault = vi.fn();

    await act(async () => {
      dialog.props.onKeyDown({ key: "Enter", preventDefault });
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ role: "dialog" }).length).toBe(1);

    await act(async () => {
      dialog.props.onKeyDown({ key: " ", preventDefault });
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ role: "dialog" }).length).toBe(1);

    await act(async () => {
      dialog.props.onKeyDown({ key: "Escape", preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({ role: "dialog" }).length).toBe(0);
  });
});
