// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContinuousChatToggle } from "./ContinuousChatToggle";

afterEach(() => {
  cleanup();
});

describe("ContinuousChatToggle", () => {
  it("renders the three-segment switch with the active mode marked", () => {
    render(<ContinuousChatToggle value="vad-gated" onChange={() => {}} />);
    const group = screen.getByRole("radiogroup");
    expect(group.getAttribute("data-mode")).toBe("vad-gated");

    const buttons = group.querySelectorAll("button[role='radio']");
    expect(buttons.length).toBe(3);

    const active = group.querySelector("button[data-mode='vad-gated']");
    expect(active?.getAttribute("aria-checked")).toBe("true");

    const inactive = group.querySelector("button[data-mode='off']");
    expect(inactive?.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onChange when the user selects a different mode", () => {
    const onChange = vi.fn();
    render(<ContinuousChatToggle value="off" onChange={onChange} />);

    const alwaysOn = screen.getByRole("radiogroup").querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;
    fireEvent.click(alwaysOn);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("always-on");
  });

  it("does not re-emit onChange when the same mode is clicked", () => {
    const onChange = vi.fn();
    render(<ContinuousChatToggle value="off" onChange={onChange} />);
    const off = screen.getByRole("radiogroup").querySelector(
      "button[data-mode='off']",
    ) as HTMLButtonElement;
    fireEvent.click(off);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores clicks while disabled", () => {
    const onChange = vi.fn();
    render(
      <ContinuousChatToggle value="off" onChange={onChange} disabled />,
    );
    const alwaysOn = screen.getByRole("radiogroup").querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;
    fireEvent.click(alwaysOn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("compact variant cycles through modes on click", () => {
    const onChange = vi.fn();
    render(
      <ContinuousChatToggle value="off" onChange={onChange} compact />,
    );

    const button = screen.getByTestId("continuous-chat-toggle");
    expect(button.getAttribute("data-mode")).toBe("off");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith("vad-gated");
  });
});
