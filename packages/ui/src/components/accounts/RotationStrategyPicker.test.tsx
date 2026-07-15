/**
 * Verifies strategy descriptions remain list-only so Radix cannot mirror a
 * two-line option into the compact trigger, including reset-soonest selection.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => cleanup());

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
}));

import { RotationStrategyPicker } from "./RotationStrategyPicker";

describe("RotationStrategyPicker", () => {
  it("mirrors only the label into the trigger while retaining list descriptions", () => {
    render(
      <RotationStrategyPicker
        providerId="openai-api"
        value="least-used"
        onChange={() => undefined}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(within(trigger).getByText("Least used")).toBeTruthy();
    expect(
      within(trigger).queryByText(
        "Prefer the account with the lowest current usage.",
      ),
    ).toBeNull();

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(
      screen.getByText("Prefer the account with the lowest current usage."),
    ).toBeTruthy();
  });

  it("offers and selects the reset-soonest strategy", () => {
    const onChange = vi.fn();
    render(
      <RotationStrategyPicker
        providerId="openai-api"
        value="priority"
        onChange={onChange}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerId: 2,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("option", { name: /Reset-soonest/i }));
    expect(onChange).toHaveBeenCalledWith("reset-soonest");
  });

  it("offers and selects the drain-soonest-reset strategy", () => {
    const onChange = vi.fn();
    render(
      <RotationStrategyPicker
        providerId="openai-api"
        value="priority"
        onChange={onChange}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerId: 2,
      pointerType: "mouse",
    });
    fireEvent.click(
      screen.getByRole("option", { name: /Drain soonest reset/i }),
    );
    expect(onChange).toHaveBeenCalledWith("drain-soonest-reset");
  });
});
