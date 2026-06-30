// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CockpitModePicker } from "./CockpitModePicker";
import type { CockpitModeConfig } from "./cockpit-modes";

afterEach(cleanup);

function Harness({
  initial,
  onChange,
}: {
  initial: CockpitModeConfig;
  onChange?: (c: CockpitModeConfig) => void;
}) {
  const [value, setValue] = useState<CockpitModeConfig>(initial);
  return (
    <CockpitModePicker
      value={value}
      onChange={(c) => {
        setValue(c);
        onChange?.(c);
      }}
    />
  );
}

describe("CockpitModePicker", () => {
  it("renders the three sanctioned modes and no experimental options", () => {
    render(
      <Harness
        initial={{ mode: "eliza-cloud", agentType: "elizaos", tier: "small" }}
      />,
    );
    expect(screen.getByTestId("cockpit-mode-eliza-cloud")).toBeTruthy();
    expect(screen.getByTestId("cockpit-mode-opencode")).toBeTruthy();
    expect(screen.getByTestId("cockpit-mode-claude")).toBeTruthy();
    expect(screen.getByTestId("cockpit-mode-codex")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-mode-claude-experimental")).toBeNull();
    expect(screen.queryByTestId("cockpit-mode-codex-experimental")).toBeNull();
  });

  it("marks the selected mode and renders the Eliza-Cloud tier toggle", () => {
    render(
      <Harness
        initial={{ mode: "eliza-cloud", agentType: "elizaos", tier: "large" }}
      />,
    );
    expect(
      screen
        .getByTestId("cockpit-mode-eliza-cloud")
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // tier toggle only renders for the active eliza-cloud card
    expect(screen.getByTestId("cockpit-tier-small")).toBeTruthy();
    expect(screen.getByTestId("cockpit-tier-large")).toBeTruthy();
  });

  it("does not render the tier toggle for a non-cloud mode", () => {
    render(<Harness initial={{ mode: "subscription", agentType: "codex" }} />);
    expect(screen.queryByTestId("cockpit-tier-small")).toBeNull();
  });

  it("selecting a mode emits the right config", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ mode: "eliza-cloud", agentType: "elizaos", tier: "small" }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByTestId("cockpit-mode-claude"));
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "subscription",
      agentType: "claude",
    });
  });

  it("flipping the Eliza-Cloud tier emits the new tier", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ mode: "eliza-cloud", agentType: "elizaos", tier: "small" }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByTestId("cockpit-tier-large"));
    expect(onChange).toHaveBeenLastCalledWith({
      mode: "eliza-cloud",
      agentType: "elizaos",
      tier: "large",
    });
  });

  it("does not emit when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CockpitModePicker
        value={{ mode: "opencode", agentType: "opencode" }}
        onChange={onChange}
        disabled
      />,
    );
    await user.click(screen.getByTestId("cockpit-mode-claude"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
