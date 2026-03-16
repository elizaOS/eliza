import { SaveCommandModal } from "@elizaos/app-core/components";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

describe("SaveCommandModal keyboard behavior", () => {
  it("closes only on Escape from dialog keydown", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(SaveCommandModal, {
          open: true,
          text: "test content",
          onSave,
          onClose,
        }),
      );
    });

    const dialog = tree.root.findByProps({ role: "dialog" });
    const preventDefault = vi.fn();

    act(() => {
      dialog.props.onKeyDown({ key: "Enter", preventDefault });
      dialog.props.onKeyDown({ key: " ", preventDefault });
      dialog.props.onKeyDown({ key: "Escape", preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Enter during IME composition", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(SaveCommandModal, {
          open: true,
          text: "test content",
          onSave,
          onClose,
        }),
      );
    });

    const input = tree.root.findByType("input");

    act(() => {
      input.props.onChange({ target: { value: "my-command" } });
      input.props.onKeyDown({
        key: "Enter",
        nativeEvent: { isComposing: true },
      });
    });

    expect(onSave).not.toHaveBeenCalled();

    act(() => {
      input.props.onKeyDown({
        key: "Enter",
        nativeEvent: { isComposing: false },
      });
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("my-command");
  });

  it("wires validation error state to input aria attributes", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(SaveCommandModal, {
          open: true,
          text: "test content",
          onSave,
          onClose,
        }),
      );
    });

    const saveButton = tree.root.find(
      (node) =>
        node.type === "button" &&
        node.props.children === "savecommandmodal.Save",
    );

    act(() => {
      saveButton.props.onClick();
    });

    const input = tree.root.find((node) => node.type === "input");
    const errorText = tree.root.find(
      (node) => node.type === "p" && node.props.children === "Name is required",
    );

    expect(input.props["aria-invalid"]).toBe("true");
    expect(input.props["aria-describedby"]).toBe(errorText.props.id);
  });
});
