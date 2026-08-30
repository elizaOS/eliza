/**
 * Verifies the real ContentState and page-panel adapters across empty/loading
 * placement, action, passthrough, and screen-reader description behavior.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { AlertTriangle } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentState } from "./content-state";
import { PageEmptyState } from "./page-panel-empty";
import { PageLoadingState } from "./page-panel-loading";

afterEach(cleanup);

describe("ContentState", () => {
  it("renders the empty panel recipe with action and passthrough attributes", () => {
    render(
      <ContentState
        state="empty"
        title="No agents"
        description="Create an agent to continue."
        action={<button type="button">Create agent</button>}
        data-testid="state"
      />,
    );

    const state = screen.getByTestId("state");
    expect(state.getAttribute("data-slot")).toBe("empty-state");
    expect(state.classList.contains("min-h-[12rem]")).toBe(true);
    expect(screen.getByRole("heading", { name: "No agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create agent" })).toBeTruthy();
  });

  it("renders workspace empty content without adding panel chrome", () => {
    render(
      <ContentState
        state="empty"
        placement="workspace"
        title="No results"
        description="Change the filters and try again."
        icon={<AlertTriangle data-testid="empty-icon" />}
        data-testid="state"
      />,
    );

    const state = screen.getByTestId("state");
    expect(state.classList.contains("min-h-0")).toBe(true);
    expect(state.classList.contains("flex-1")).toBe(true);
    expect(state.hasAttribute("data-slot")).toBe(false);
    expect(screen.getByText("No results").tagName).toBe("DIV");
    expect(screen.getByTestId("empty-icon")).toBeTruthy();
  });

  it("keeps loading descriptions screen-reader-only", () => {
    render(
      <ContentState
        state="loading"
        heading="Loading workspace"
        description="Fetching your agents."
      />,
    );

    expect(screen.getByText("Loading workspace")).toBeTruthy();
    expect(
      screen.getByText("Fetching your agents.").classList.contains("sr-only"),
    ).toBe(true);
  });

  it("renders a recoverable error as one accessible alert", () => {
    render(
      <ContentState
        state="error"
        placement="workspace"
        icon={<AlertTriangle />}
        title="Knowledge unavailable"
        description="Reconnect to load your documents."
        action={<button type="button">Retry</button>}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Knowledge unavailable");
    expect(alert.textContent).toContain("Reconnect to load your documents.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("page-panel content-state adapters", () => {
  it("preserves PageEmptyState inset geometry", () => {
    render(
      <PageEmptyState variant="inset" title="No files" data-testid="empty" />,
    );

    expect(
      screen.getByTestId("empty").classList.contains("min-h-[10rem]"),
    ).toBe(true);
  });

  it("preserves PageLoadingState workspace geometry", () => {
    render(
      <PageLoadingState
        variant="workspace"
        heading="Loading files"
        data-testid="loading"
      />,
    );

    const loading = screen.getByTestId("loading");
    expect(loading.classList.contains("min-h-[58vh]")).toBe(true);
    expect(loading.classList.contains("overflow-hidden")).toBe(true);
  });
});
