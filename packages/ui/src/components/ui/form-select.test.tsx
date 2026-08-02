/**
 * Verifies the form-select convenience wrapper forwards its accessible name to
 * the actual Radix trigger rather than the non-DOM root controller.
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormSelect, FormSelectItem } from "./form-select";

describe("FormSelect", () => {
  it("names the rendered combobox", () => {
    render(
      <FormSelect aria-label="Model" placeholder="Choose a model">
        <FormSelectItem value="small">Small</FormSelectItem>
      </FormSelect>,
    );

    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  });
});
