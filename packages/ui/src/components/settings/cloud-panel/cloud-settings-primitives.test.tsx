/**
 * Verifies the deterministic DOM contract used to draw Cloud Settings row
 * separators, the native drag strip, and modal focus management, all against
 * the canonical in-package primitives (no external component dependency).
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { CloudSettingsDragStrip } from "./CloudSettingsPanel";
import { CloudModal, SettingsGroup } from "./cloud-settings-primitives";

describe("SettingsGroup", () => {
  it("uses the scoped sibling-row separator contract", () => {
    const { container } = render(
      <SettingsGroup title="Shortcuts">
        <div>First</div>
        <div>Second</div>
      </SettingsGroup>,
    );

    expect(screen.getByRole("heading", { name: "Shortcuts" })).toBeTruthy();
    const rows = container.querySelector(
      '[class*=":not([hidden])+:not([hidden])"]',
    );
    expect(rows).toBeTruthy();
    expect(rows?.children).toHaveLength(2);
  });
});

describe("CloudSettingsDragStrip", () => {
  it("marks the invisible top strip as native window chrome", () => {
    const { container } = render(<CloudSettingsDragStrip />);

    const strip = container.querySelector('[data-window-titlebar="true"]');
    expect(strip).toBeTruthy();
    expect(strip?.classList.contains("settings-window-drag-strip")).toBe(true);
    expect(strip?.getAttribute("aria-hidden")).toBe("true");
  });
});

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open connector
      </button>
      <button type="button">Background action</button>
      <CloudModal
        open={open}
        title="Add connector"
        description="Enter connector details."
        onClose={() => setOpen(false)}
      >
        <input aria-label="Connector name" />
        <button type="button">Save connector</button>
      </CloudModal>
    </div>
  );
}

describe("CloudModal", () => {
  it("contains focus and restores it to the opener when closed", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    const opener = screen.getByRole("button", { name: "Open connector" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Add connector" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add connector" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
