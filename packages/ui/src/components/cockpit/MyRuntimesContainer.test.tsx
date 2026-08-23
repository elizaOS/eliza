/** Verifies the legacy import delegates to the canonical Devices product. */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings/DevicesRuntimesContainer", () => ({
  DevicesRuntimesContainer: ({ className }: { className?: string }) => (
    <div data-testid="canonical-devices-runtimes" className={className} />
  ),
}));

import { MyRuntimesContainer } from "./MyRuntimesContainer";

afterEach(cleanup);

describe("MyRuntimesContainer compatibility adapter", () => {
  it("renders the one canonical Devices & Runtimes container", () => {
    render(<MyRuntimesContainer className="legacy-slot" />);
    expect(screen.getByTestId("canonical-devices-runtimes").className).toBe(
      "legacy-slot",
    );
  });
});
