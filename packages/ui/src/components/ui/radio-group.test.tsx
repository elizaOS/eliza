/** Behavioral contract for keyboard-accessible single selection. */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioGroup, RadioGroupItem } from "./radio-group";

afterEach(cleanup);

describe("RadioGroup", () => {
  it("reports exactly one selected value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        defaultValue="first"
        onValueChange={onValueChange}
        aria-label="Choice"
      >
        <RadioGroupItem value="first" aria-label="First" />
        <RadioGroupItem value="second" aria-label="Second" />
      </RadioGroup>,
    );
    await user.click(screen.getByRole("radio", { name: "Second" }));
    expect(onValueChange).toHaveBeenCalledWith("second");
    expect(
      screen.getByRole("radio", { name: "Second" }).getAttribute("data-state"),
    ).toBe("checked");
  });
});
