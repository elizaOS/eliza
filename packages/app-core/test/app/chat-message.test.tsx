// @vitest-environment jsdom

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("../../src/components/MessageContent", () => ({
  MessageContent: ({ message }: { message: { text: string } }) =>
    React.createElement("span", null, message.text),
}));

import { ChatMessage } from "../../src/components/ChatMessage";

describe("ChatMessage actions", () => {
  it("reveals assistant actions on tap when hover is unavailable", async () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    mockUseApp.mockReturnValue({
      copyToClipboard: vi.fn(),
      t: (key: string) => key,
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatMessage, {
          message: {
            id: "assistant-1",
            role: "assistant",
            text: "hello there",
            timestamp: 1,
          },
          onSpeak: vi.fn(),
        }),
      );
    });

    const actionButtonsBeforeTap = tree.root.findAll(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Copy message",
    );
    expect(actionButtonsBeforeTap).toHaveLength(1);
    expect(
      tree.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("pointer-events-none opacity-0"),
      ),
    ).toHaveLength(1);

    await act(async () => {
      tree.root
        .findByProps({ "data-testid": "chat-message" })
        .props.onTouchEnd({
          target: {
            closest: () => null,
          },
        });
    });

    tree.root.findByProps({ "aria-label": "Copy message" });
    expect(
      tree.root.findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("opacity-100"),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findByProps({ "aria-label": "Play message" }),
    ).toBeDefined();
  });

  it("renders copy and play actions for assistant messages", async () => {
    mockUseApp.mockReturnValue({
      copyToClipboard: vi.fn(),
      t: (key: string) => key,
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatMessage, {
          message: {
            id: "assistant-1",
            role: "assistant",
            text: "hello there",
            timestamp: 1,
          },
          onSpeak: vi.fn(),
        }),
      );
    });

    expect(
      tree.root.findByProps({ "aria-label": "Copy message" }),
    ).toBeDefined();
    expect(
      tree.root.findByProps({ "aria-label": "Play message" }),
    ).toBeDefined();
  });

  it("plays assistant messages from the message action button", async () => {
    mockUseApp.mockReturnValue({
      copyToClipboard: vi.fn(),
      t: (key: string) => key,
    });
    const onSpeak = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatMessage, {
          message: {
            id: "assistant-1",
            role: "assistant",
            text: "hello there",
            timestamp: 1,
          },
          onSpeak,
        }),
      );
    });

    const playButton = tree.root.findByProps({ "aria-label": "Play message" });
    await act(async () => {
      playButton.props.onClick();
    });

    expect(onSpeak).toHaveBeenCalledWith("assistant-1", "hello there");
  });

  it("edits and resends user messages from the inline editor", async () => {
    mockUseApp.mockReturnValue({
      copyToClipboard: vi.fn(),
      t: (key: string) => key,
    });
    const onEdit = vi.fn(async () => true);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatMessage, {
          message: {
            id: "user-1",
            role: "user",
            text: "old text",
            timestamp: 1,
          },
          onEdit,
        }),
      );
    });

    const editButton = tree.root.findByProps({ "aria-label": "Edit message" });
    await act(async () => {
      editButton.props.onClick();
    });

    const textarea = tree.root.findByProps({ "aria-label": "Edit message" });
    await act(async () => {
      textarea.props.onChange({ target: { value: "edited text" } });
    });

    const saveButton = tree.root
      .findAllByType("button")
      .find((button) =>
        button.children.some((child) => child === "Save and resend"),
      );
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.props.onClick();
    });

    expect(onEdit).toHaveBeenCalledWith("user-1", "edited text");
  });

  it("does not render a retry action for interrupted assistant messages", async () => {
    mockUseApp.mockReturnValue({
      copyToClipboard: vi.fn(),
      t: (key: string) => key,
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatMessage, {
          message: {
            id: "assistant-1",
            role: "assistant",
            text: "partial",
            interrupted: true,
            timestamp: 1,
          },
          onSpeak: vi.fn(),
        }),
      );
    });

    expect(
      tree.root.findAllByProps({ "aria-label": "Retry message" }),
    ).toHaveLength(0);
  });
});
