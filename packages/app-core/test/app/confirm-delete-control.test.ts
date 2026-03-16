import { ConfirmDeleteControl } from "@elizaos/app-core/components";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

function createSubject(
  overrides: Partial<React.ComponentProps<typeof ConfirmDeleteControl>> = {},
) {
  return React.createElement(ConfirmDeleteControl, {
    onConfirm: () => {},
    triggerClassName: "trigger",
    confirmClassName: "confirm",
    cancelClassName: "cancel",
    ...overrides,
  });
}

describe("ConfirmDeleteControl", () => {
  it("shows trigger first and then confirm/cancel state", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(createSubject());
    });

    const trigger = tree.root.findByProps({ className: "trigger" });
    expect(trigger.props.children).toBe("Delete");

    act(() => {
      trigger.props.onClick();
    });

    const confirm = tree.root.findByProps({ className: "confirm" });
    const cancel = tree.root.findByProps({ className: "cancel" });
    expect(confirm.props.children).toBe("Confirm");
    expect(cancel.props.children).toBe("Cancel");
  });

  it("runs confirm callback and resets state", () => {
    const onConfirm = vi.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(createSubject({ onConfirm }));
    });

    const trigger = tree.root.findByProps({ className: "trigger" });
    act(() => {
      trigger.props.onClick();
    });

    const confirm = tree.root.findByProps({ className: "confirm" });
    act(() => {
      confirm.props.onClick();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(tree.root.findByProps({ className: "trigger" })).toBeDefined();
  });

  it("uses busy label while disabled in confirm state", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(createSubject({ busyLabel: "...working..." }));
    });

    const trigger = tree.root.findByProps({ className: "trigger" });
    act(() => {
      trigger.props.onClick();
    });

    act(() => {
      tree.update(
        createSubject({ disabled: true, busyLabel: "...working..." }),
      );
    });

    const confirm = tree.root.findByProps({ className: "confirm" });
    expect(confirm.props.children).toBe("...working...");
  });
});
