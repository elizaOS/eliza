// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PerfOverlay } from "./PerfOverlay";

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__ELIZA_PERF__;
});

describe("PerfOverlay gate (#9141)", () => {
  it("renders nothing (and starts no loop) when __ELIZA_PERF__ is off", () => {
    const { container } = render(<PerfOverlay />);
    expect(container.querySelector('[data-testid="perf-overlay"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
