/** Verifies dashboard loading chrome does not expose retired infrastructure columns. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContainersSkeleton } from "./cloud-dashboard-components";

describe("ContainersSkeleton", () => {
  afterEach(cleanup);

  it("mirrors the product-facing Agents table while data loads", () => {
    render(<ContainersSkeleton />);

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("Web UI")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByText("Created")).toBeNull();
  });
});
