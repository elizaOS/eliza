// @vitest-environment jsdom

// Disable createPortal in ConfirmModal when using react-test-renderer
(globalThis as Record<string, unknown>).__TEST_RENDERER__ = true;

import {
  ConfirmModal,
  PromptModal,
  useConfirm,
  usePrompt,
} from "@elizaos/app-core/components";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function findButton(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance {
  const match = root
    .findAllByType("button" as React.ElementType)
    .find((node) => node.children.join("").includes(label));
  if (!match) {
    throw new Error(`Could not find button with label: ${label}`);
  }
  return match;
}

let latestConfirm!: ReturnType<typeof useConfirm>;
let latestPrompt!: ReturnType<typeof usePrompt>;

function ConfirmHarness() {
  latestConfirm = useConfirm();
  return React.createElement(ConfirmModal, latestConfirm.modalProps);
}

function PromptHarness() {
  latestPrompt = usePrompt();
  return React.createElement(PromptModal, latestPrompt.modalProps);
}

describe("ConfirmModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when closed", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(ConfirmModal, {
          open: false,
          message: "Delete this item?",
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    expect(tree.toJSON()).toBeNull();
  });

  it("cancels on Escape and confirms from the primary button", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(ConfirmModal, {
          open: true,
          title: "Delete item",
          message: "Delete this item?",
          confirmLabel: "Delete",
          cancelLabel: "Keep",
          tone: "danger",
          onConfirm,
          onCancel,
        }),
      );
      vi.runAllTimers();
    });

    const dialog = tree.root.findByProps({ role: "dialog" });

    act(() => {
      dialog.props.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      });
    });

    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => {
      findButton(tree.root, "Delete").props.onClick();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("useConfirm resolves true from the confirm button", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(ConfirmHarness));
    });

    let resultPromise!: Promise<boolean>;
    act(() => {
      resultPromise = latestConfirm.confirm({
        title: "Delete item",
        message: "Delete this item?",
        confirmLabel: "Delete",
        tone: "danger",
      });
      vi.runAllTimers();
    });

    expect(latestConfirm.modalProps.open).toBe(true);

    await act(async () => {
      findButton(tree.root, "Delete").props.onClick();
    });

    await expect(resultPromise).resolves.toBe(true);
    expect(tree.toJSON()).toBeNull();
  });

  it("useConfirm resolves false from the cancel button", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(ConfirmHarness));
    });

    let resultPromise!: Promise<boolean>;
    act(() => {
      resultPromise = latestConfirm.confirm({
        title: "Discard draft",
        message: "Discard your changes?",
        cancelLabel: "Stay",
      });
      vi.runAllTimers();
    });

    await act(async () => {
      findButton(tree.root, "Stay").props.onClick();
    });

    await expect(resultPromise).resolves.toBe(false);
    expect(tree.toJSON()).toBeNull();
  });
});

describe("PromptModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms the entered value", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(PromptHarness));
    });

    let resultPromise!: Promise<string | null>;
    act(() => {
      resultPromise = latestPrompt.prompt({
        title: "Wallet Export Token",
        message: "Enter export token",
        confirmLabel: "Export",
      });
      vi.runAllTimers();
    });

    const input = tree.root.findByType("input" as React.ElementType);
    act(() => {
      input.props.onChange({ target: { value: "token-123" } });
    });

    await act(async () => {
      findButton(tree.root, "Export").props.onClick();
    });

    await expect(resultPromise).resolves.toBe("token-123");
    expect(tree.toJSON()).toBeNull();
  });

  it("returns null on cancel", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(PromptHarness));
    });

    let resultPromise!: Promise<string | null>;
    act(() => {
      resultPromise = latestPrompt.prompt({
        title: "Prompt",
        message: "Enter text",
        cancelLabel: "Skip",
      });
      vi.runAllTimers();
    });

    await act(async () => {
      findButton(tree.root, "Skip").props.onClick();
    });

    await expect(resultPromise).resolves.toBeNull();
    expect(tree.toJSON()).toBeNull();
  });
});
