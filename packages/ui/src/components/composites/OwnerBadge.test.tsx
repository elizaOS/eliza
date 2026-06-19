// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OwnerBadge } from "./OwnerBadge";

afterEach(() => {
  cleanup();
});

describe("OwnerBadge", () => {
  it("renders the Crown when isOwner is true", () => {
    render(<OwnerBadge isOwner />);
    expect(screen.getByTestId("owner-badge")).toBeTruthy();
  });

  it("renders nothing when isOwner is false", () => {
    const { container } = render(<OwnerBadge isOwner={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("defaults to isOwner=true so inline callers can pass-through", () => {
    render(<OwnerBadge />);
    expect(screen.getByTestId("owner-badge")).toBeTruthy();
  });

  it("supports inline / overlay / card variants", () => {
    const { rerender } = render(<OwnerBadge variant="inline" />);
    expect(screen.getByTestId("owner-badge").getAttribute("data-variant")).toBe(
      "inline",
    );

    rerender(<OwnerBadge variant="overlay" />);
    expect(screen.getByTestId("owner-badge").getAttribute("data-variant")).toBe(
      "overlay",
    );

    rerender(<OwnerBadge variant="card" />);
    expect(screen.getByTestId("owner-badge").getAttribute("data-variant")).toBe(
      "card",
    );
  });

  it("uses the provided tooltip", () => {
    render(<OwnerBadge tooltip="You are the OWNER" />);
    expect(screen.getByTestId("owner-badge").getAttribute("title")).toBe(
      "You are the OWNER",
    );
  });

  it("supports custom test ids", () => {
    render(<OwnerBadge data-testid="header-owner-badge" />);
    expect(screen.getByTestId("header-owner-badge")).toBeTruthy();
  });
});
