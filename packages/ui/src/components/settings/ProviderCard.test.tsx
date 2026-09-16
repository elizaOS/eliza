/**
 * Locks ProviderCard's serving-vs-inspecting chrome: `current` is the
 * provider answering inference, `selected` is only the open panel. The two
 * must not share the orange Active treatment (#20045). jsdom harness.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { Cloud, Cpu } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCard } from "./ProviderCard";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: undefined, agentProps: {} }),
}));

function renderTile(
  overrides: Partial<{ current: boolean; selected: boolean }>,
) {
  return render(
    <ProviderCard
      id="__cloud__"
      icon={Cloud}
      label="Eliza Cloud"
      category="cloud"
      status={{ tone: "warn", label: "Not signed in" }}
      current={false}
      selected={false}
      onSelect={vi.fn()}
      variant="tile"
      description="Managed models."
      {...overrides}
    />,
  );
}

describe("ProviderCard — serving vs inspecting", () => {
  afterEach(cleanup);

  it("marks the serving tile current and Active, even when it is also open", () => {
    renderTile({ current: true, selected: true });
    const tile = screen.getByRole("button", { name: "Eliza Cloud, Active" });
    expect(tile.getAttribute("aria-current")).toBe("true");
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(tile.dataset.providerPresentation).toBe("current");
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("does not paint the open-but-not-serving tile as Active", () => {
    renderTile({ current: false, selected: true });
    const tile = screen.getByRole("button", {
      name: "Eliza Cloud, Not signed in",
    });
    expect(tile.getAttribute("aria-current")).toBeNull();
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(tile.dataset.providerPresentation).toBe("selected");
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("keeps the serving tile orange when the other panel is open", () => {
    render(
      <ProviderCard
        id="__local__"
        icon={Cpu}
        label="Local provider"
        category="local"
        status={{ tone: "ok", label: "Active" }}
        current
        selected={false}
        onSelect={vi.fn()}
        variant="tile"
        description="On this device."
      />,
    );
    const tile = screen.getByRole("button", {
      name: "Local provider, Active",
    });
    expect(tile.getAttribute("aria-current")).toBe("true");
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    expect(tile.dataset.providerPresentation).toBe("current");
  });
});
