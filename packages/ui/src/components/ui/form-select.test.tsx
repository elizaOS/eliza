/**
 * Verifies the form-select convenience wrapper forwards its accessible name to
 * the actual Radix trigger rather than the non-DOM root controller.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormSelect, FormSelectItem } from "./form-select";

afterEach(cleanup);

describe("FormSelect", () => {
  it("names the rendered combobox", () => {
    render(
      <FormSelect aria-label="Model" placeholder="Choose a model">
        <FormSelectItem value="small">Small</FormSelectItem>
      </FormSelect>,
    );

    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  });

  it("retains the shared touch floor when a caller uses a compact trigger", () => {
    render(
      <FormSelect
        aria-label="Model"
        placeholder="Choose a model"
        triggerClassName="h-9 w-auto"
      >
        <FormSelectItem value="small">Small</FormSelectItem>
      </FormSelect>,
    );

    const className = screen.getByRole("combobox", { name: "Model" }).className;
    expect(className).toContain("h-9");
    expect(className).toContain("w-auto");
    expect(className).toContain("pointer-coarse:min-h-touch");
    expect(className).toContain("pointer-coarse:min-w-touch");
  });
});
