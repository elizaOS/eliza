/**
 * Verifies the deterministic DOM contract used to draw Cloud Settings row
 * separators without relying on NuPhy's generated Tailwind divide utilities.
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@extrastu/nuphy-ui", () => ({
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Input: () => <input />,
  IosToggle: () => <button type="button">Toggle</button>,
  Segmented: () => <div />,
  SelectPill: () => <div />,
  SettingRow: ({ title }: { title: string }) => <div>{title}</div>,
  Slider: () => <input type="range" />,
}));

import { CloudSettingsDragStrip } from "./CloudSettingsPanel";
import { SettingsGroup } from "./nuphy-settings-primitives";

describe("SettingsGroup", () => {
  it("uses the scoped sibling-row separator contract", () => {
    const { container } = render(
      <SettingsGroup title="Shortcuts">
        <div>First</div>
        <div>Second</div>
      </SettingsGroup>,
    );

    expect(screen.getByRole("heading", { name: "Shortcuts" })).toBeTruthy();
    const rows = container.querySelector(".nuphy-settings-group-rows");
    expect(rows).toBeTruthy();
    expect(rows?.classList.contains("divide-y")).toBe(false);
    expect(rows?.children).toHaveLength(2);
  });
});

describe("CloudSettingsDragStrip", () => {
  it("marks the invisible top strip as native window chrome", () => {
    const { container } = render(<CloudSettingsDragStrip />);

    const strip = container.querySelector('[data-window-titlebar="true"]');
    expect(strip).toBeTruthy();
    expect(strip?.classList.contains("nuphy-window-drag-strip")).toBe(true);
    expect(strip?.getAttribute("aria-hidden")).toBe("true");
  });
});
