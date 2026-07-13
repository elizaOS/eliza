// @vitest-environment jsdom
//
// OrchestratorView is the GUI route component the bundle exports. It renders the
// full rich OrchestratorWorkbench through the spatial `Escape` hatch; the
// retained spatial summary stays available as a future-adapter seam. These tests
// pin the shipped DOM contract: the rich workbench mounts inside the escape box,
// not the spatial summary.

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  OrchestratorTaskWidget: () => (
    <div data-testid="live-orchestrator-task-stream">live tasks</div>
  ),
}));

// The rich workbench pulls the whole @elizaos/ui surface; stub it so the DOM
// surface is testable without the full host. The escape hatch renders this stub
// as its real DOM children in the shipped GUI surface.
vi.mock("./OrchestratorWorkbench.tsx", () => ({
  OrchestratorWorkbench: () => (
    <div data-testid="rich-orchestrator-workbench">workbench</div>
  ),
}));

import { OrchestratorView } from "./OrchestratorView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrchestratorView — GUI route component", () => {
  it("GUI: mounts the rich workbench inside the escape hatch", () => {
    const { container } = render(React.createElement(OrchestratorView));
    const escapeBox = container.querySelector('[data-spatial-kind="escape"]');
    expect(escapeBox).toBeTruthy();
    expect(
      escapeBox?.querySelector('[data-testid="rich-orchestrator-workbench"]'),
    ).toBeTruthy();
    expect(
      escapeBox?.querySelector('[data-testid="live-orchestrator-task-stream"]'),
    ).toBeTruthy();
  });

  it("GUI: renders the rich workbench, not the spatial summary fallback", () => {
    const { container } = render(React.createElement(OrchestratorView));
    // In the DOM surface the escape hatch renders its children (the workbench),
    // so the spatial summary controls stay absent.
    expect(container.textContent).not.toContain("Pause all");
    expect(container.textContent).not.toContain(
      "Describe a task in chat to start one.",
    );
  });
});
