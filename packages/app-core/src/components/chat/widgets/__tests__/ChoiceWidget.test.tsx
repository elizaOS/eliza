// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceWidget } from "../ChoiceWidget";

describe("ChoiceWidget", () => {
  afterEach(() => {
    cleanup();
  });

  const baseOptions = [
    { value: "new", label: "Create new" },
    { value: "edit-1", label: "Edit Babylon" },
    { value: "cancel", label: "Cancel" },
  ];

  it("renders every option as a button", () => {
    render(
      <ChoiceWidget
        id="abc"
        scope="app-create"
        options={baseOptions}
        onChoose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Create new" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Babylon" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("invokes onChoose with the value when a button is clicked", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceWidget
        id="abc"
        scope="app-create"
        options={baseOptions}
        onChoose={onChoose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Babylon" }));

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("edit-1");
  });

  it("disables every button after a single selection", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceWidget
        id="abc"
        scope="app-create"
        options={baseOptions}
        onChoose={onChoose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create new" }));

    for (const option of baseOptions) {
      const button = screen.getByTestId(
        `choice-${option.value}`,
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }

    // Subsequent clicks must be ignored.
    fireEvent.click(screen.getByTestId("choice-edit-1"));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});
