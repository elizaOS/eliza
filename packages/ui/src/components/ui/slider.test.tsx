/** Verifies Slider through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Accessible slider coverage verifies that names reach Radix's focusable
 * thumbs and that range values render one independently named thumb per value.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Slider } from "./slider";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

describe("Slider", () => {
  it("names its focusable thumb", () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} />);

    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
  });

  it("renders and distinguishes every thumb in a range", () => {
    render(<Slider aria-label="Price range" defaultValue={[25, 75]} />);

    expect(screen.getByRole("slider", { name: "Price range 1" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Price range 2" })).toBeTruthy();
  });
});
