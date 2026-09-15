/** Verifies the canonical connector capability tile's content hierarchy. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionCapabilityTile } from "./connection-capability-tile";

afterEach(cleanup);

describe("ConnectionCapabilityTile", () => {
  it("renders the provider icon, title, and description in one tile", () => {
    render(
      <ConnectionCapabilityTile
        icon={<svg data-testid="provider-icon" />}
        title="Calendar"
        description="Manage shared events"
      />,
    );

    expect(screen.getByTestId("provider-icon")).toBeTruthy();
    expect(screen.getByText("Calendar").tagName).toBe("P");
    expect(screen.getByText("Manage shared events").tagName).toBe("P");
  });
});
