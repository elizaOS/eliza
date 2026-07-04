// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionCard, ConnectionConnectedBadge } from "./connection-card";

describe("ConnectionCard mobile layout", () => {
  it("keeps long connector titles and status badges inside the card surface", () => {
    const { container } = render(
      <ConnectionCard
        name="Extremely Long Enterprise Messaging Connector Name That Must Wrap"
        icon={<span aria-hidden="true">C</span>}
        description="A connector description that should wrap instead of forcing the dashboard pane wider than a phone viewport."
        status="connected"
        statusBadge={
          <ConnectionConnectedBadge label="Connected with a very long label" />
        }
        connectedContent={<p>Connected</p>}
      />,
    );

    const card = container.querySelector("[data-slot='connection-card']");
    expect(card?.classList.contains("min-w-0")).toBe(true);
    expect(card?.classList.contains("overflow-hidden")).toBe(true);
    expect(
      screen.getByText(/Extremely Long/).classList.contains("break-words"),
    ).toBe(true);
    expect(
      screen
        .getByText(/connector description/)
        .classList.contains("break-words"),
    ).toBe(true);
  });
});
