// @vitest-environment jsdom
//
// Interaction tests for CockpitTierToggle: flipping the segmented control emits
// the selected Eliza Cloud tier. Deterministic RTL/jsdom, no network.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CockpitTierToggle } from "./CockpitTierToggle";

afterEach(cleanup);

describe("CockpitTierToggle", () => {
  it("flips to the smart tier on click", () => {
    const onChange = vi.fn();
    render(<CockpitTierToggle value="small" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("cockpit-tier-large"));
    expect(onChange).toHaveBeenCalledWith("large");
  });

  it("does not fire onChange when the current tier is re-selected", () => {
    const onChange = vi.fn();
    render(<CockpitTierToggle value="small" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("cockpit-tier-small"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not fire onChange when disabled", () => {
    const onChange = vi.fn();
    render(<CockpitTierToggle value="small" onChange={onChange} disabled />);
    fireEvent.click(screen.getByTestId("cockpit-tier-large"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
