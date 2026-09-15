/** Verifies settings density adapters preserve the Select touch contract. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Select, SelectValue } from "./select";
import { SettingsSelectTrigger } from "./settings-controls";

afterEach(cleanup);

describe("SettingsSelectTrigger touch-target contract", () => {
  it("keeps its compact fine-pointer height and inherits the coarse floor", () => {
    render(
      <Select defaultValue="balanced">
        <SettingsSelectTrigger aria-label="Model mode">
          <SelectValue />
        </SettingsSelectTrigger>
      </Select>,
    );

    const className = screen.getByRole("combobox", {
      name: "Model mode",
    }).className;
    expect(className).toContain("h-9");
    expect(className).toContain("pointer-coarse:min-h-touch");
    expect(className).toContain("pointer-coarse:min-w-touch");
  });
});
