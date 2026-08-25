/** Verifies SelectableTile behavior and accessibility in the jsdom component harness. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectableTile } from "./selectable-tile";

afterEach(cleanup);

describe("SelectableTile", () => {
  it("exposes its visible label and selected state without ON or OFF copy", () => {
    const { rerender } = render(
      <SelectableTile
        selected
        label="English"
        leading={<span>EN</span>}
        onSelect={vi.fn()}
      />,
    );

    const selected = screen.getByRole("button", { name: "English" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(
      selected.querySelector('[data-slot="selectable-tile-indicator"]'),
    ).toBeTruthy();
    expect(screen.queryByText(/^(?:ON|OFF)$/i)).toBeNull();

    rerender(
      <SelectableTile
        selected={false}
        label="English"
        leading={<span>EN</span>}
        onSelect={vi.fn()}
      />,
    );
    expect(selected.getAttribute("aria-pressed")).toBe("false");
    expect(
      selected.querySelector('[data-slot="selectable-tile-indicator"]'),
    ).toBeNull();
  });

  it("activates from pointer and keyboard input", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectableTile
        selected={false}
        label="Orange"
        leading={<span>●</span>}
        onSelect={onSelect}
      />,
    );
    const tile = screen.getByRole("button", { name: "Orange" });

    await user.click(tile);
    tile.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("centers horizontal and vertical content and forwards its ref", () => {
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <SelectableTile
        ref={ref}
        selected={false}
        label="English"
        leading={<span>EN</span>}
        layout="horizontal"
        onSelect={vi.fn()}
      />,
    );
    const content = document.querySelector(
      '[data-slot="selectable-tile-content"]',
    );
    expect(content?.getAttribute("data-layout")).toBe("horizontal");
    expect(content?.className).toContain("items-center");
    expect(content?.className).toContain("justify-center");
    expect(ref.current).toBe(screen.getByRole("button", { name: "English" }));

    rerender(
      <SelectableTile
        selected={false}
        label="Orange"
        leading={<span>●</span>}
        layout="vertical"
        onSelect={vi.fn()}
      />,
    );
    expect(
      document
        .querySelector('[data-slot="selectable-tile-content"]')
        ?.getAttribute("data-layout"),
    ).toBe("vertical");
  });
});
