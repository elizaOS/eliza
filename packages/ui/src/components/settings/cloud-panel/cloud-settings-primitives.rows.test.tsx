/**
 * Verifies cloud row adapters through their canonical settings-row molecules,
 * including ids, accessible labels, disabled state, and callback forwarding.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudActionButton,
  CloudInputRow,
  CloudRow,
  CloudSegmentedRow,
  CloudSelectRow,
  CloudSwitchRow,
} from "./cloud-settings-primitives";

afterEach(cleanup);

describe("cloud settings row adapters", () => {
  it("forwards switch identity, accessible label, state, and changes", () => {
    const onCheckedChange = vi.fn();
    render(
      <CloudSwitchRow
        agentId="cloud-wake-word"
        agentLabel="Toggle cloud wake word"
        label="Wake word"
        description="Listen while idle."
        checked={false}
        onCheckedChange={onCheckedChange}
        testId="wake-switch"
      />,
    );

    const control = screen.getByTestId("wake-switch");
    expect(control.id).toBe("cloud-wake-word");
    expect(control.getAttribute("aria-label")).toBe("Toggle cloud wake word");
    expect(screen.getByText("Listen while idle.")).toBeTruthy();
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("keeps disabled switch and action adapters inert", () => {
    const onCheckedChange = vi.fn();
    const onActivate = vi.fn();
    render(
      <>
        <CloudSwitchRow
          agentId="disabled-switch"
          label="Disabled switch"
          checked={false}
          onCheckedChange={onCheckedChange}
          disabled
          testId="disabled-switch"
        />
        <CloudActionButton
          agentId="disabled-action"
          label="Test notification"
          buttonLabel="Send test"
          onActivate={onActivate}
          disabled
        />
      </>,
    );

    const switchControl = screen.getByTestId("disabled-switch");
    const action = screen.getByRole("button", { name: "Send test" });
    expect(switchControl.hasAttribute("disabled")).toBe(true);
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(switchControl);
    fireEvent.click(action);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("forwards input and segmented changes through canonical controls", () => {
    const onInputChange = vi.fn();
    const onSegmentChange = vi.fn();
    render(
      <>
        <CloudInputRow
          agentId="cloud-word"
          agentLabel="Cloud wake word"
          label="Word"
          value="Eliza"
          onValueChange={onInputChange}
        />
        <CloudSegmentedRow
          agentId="cloud-delivery"
          label="Delivery"
          value="push"
          onValueChange={onSegmentChange}
          options={[
            { value: "push", label: "Push" },
            { value: "digest", label: "Digest" },
          ]}
        />
        <CloudSelectRow
          agentId="cloud-quality"
          agentLabel="Cloud model quality"
          label="Quality"
          value="balanced"
          onValueChange={() => {}}
          options={[{ value: "balanced", label: "Balanced" }]}
        />
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Word" });
    expect(input.id).toBe("cloud-word");
    fireEvent.change(input, { target: { value: "Computer" } });
    expect(onInputChange).toHaveBeenCalledWith("Computer");

    fireEvent.click(screen.getByRole("button", { name: "Digest" }));
    expect(onSegmentChange).toHaveBeenCalledWith("digest");
    expect(
      screen.getByRole("combobox", { name: "Cloud model quality" }),
    ).toBeTruthy();
    expect(screen.getByText("Quality").tagName).toBe("SPAN");
  });

  it("keeps custom row content and below content in one canonical row", () => {
    render(
      <CloudRow
        label="Connection"
        control={<span>Connected</span>}
        below={<span>Last checked now</span>}
        data-testid="connection-row"
      />,
    );

    const wrapper = screen.getByTestId("connection-row");
    expect(wrapper.textContent).toContain("Connection");
    expect(wrapper.textContent).toContain("Connected");
    expect(wrapper.textContent).toContain("Last checked now");
    const rows = wrapper.querySelectorAll('[data-slot="settings-row"]');
    expect(rows).toHaveLength(1);
    expect(
      rows[0]?.querySelector('[data-slot="settings-row-content"]')?.textContent,
    ).toContain("Last checked now");
  });
});
