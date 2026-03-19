import { Switch } from "@elizaos/app-core/components";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

describe("Switch", () => {
  it("emits the toggled value when clicked", () => {
    const onChange = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(Switch, { checked: false, onChange }),
      );
    });

    const button = tree.root.findByType("button");
    expect(button.props.role).toBe("switch");
    expect(button.props["aria-checked"]).toBe(false);

    act(() => {
      button.props.onClick();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not emit changes while disabled", () => {
    const onChange = vi.fn();

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(Switch, {
          checked: true,
          onChange,
          disabled: true,
        }),
      );
    });

    const button = tree.root.findByType("button");
    act(() => {
      button.props.onClick();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies compact sizing and compact knob travel", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(Switch, {
          checked: true,
          size: "compact",
          onChange: () => {},
        }),
      );
    });

    const button = tree.root.findByType("button");
    expect(String(button.props.className)).toContain("w-10 h-6");

    const knob = tree.root.findByType("span");
    expect(String(knob.props.className)).toContain("translate-x-4");
  });
});
