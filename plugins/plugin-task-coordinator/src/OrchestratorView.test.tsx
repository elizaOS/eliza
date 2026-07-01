// @vitest-environment jsdom
//
// OrchestratorView is the single GUI/XR/TUI component the bundle exports. In
// GUI/XR it renders the full rich OrchestratorWorkbench through the spatial
// `Escape` hatch; the OrchestratorSpatialView summary is the TUI fallback. These
// tests pin the GUI half of that contract: the DOM surface mounts the rich
// workbench inside the escape box, not the spatial fallback. The TUI half (the
// spatial summary + its terminal framing) is covered by OrchestratorSpatialView
// .test.tsx and the spatial `escape` primitive's own tests.

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The rich workbench pulls the whole @elizaos/ui surface; stub it so the DOM
// surface is testable without the full host. The escape hatch renders this stub
// as its real DOM children in GUI/XR.
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

describe("OrchestratorView — unified GUI/XR/TUI component", () => {
  it("GUI: mounts the rich workbench inside the escape hatch", () => {
    const { container } = render(React.createElement(OrchestratorView));
    const escapeBox = container.querySelector('[data-spatial-kind="escape"]');
    expect(escapeBox).toBeTruthy();
    expect(
      escapeBox?.querySelector('[data-testid="rich-orchestrator-workbench"]'),
    ).toBeTruthy();
  });

  it("GUI: renders the rich workbench, not the spatial summary fallback", () => {
    const { container } = render(React.createElement(OrchestratorView));
    // In a DOM surface the escape hatch renders its children (the workbench),
    // never the `tui` spatial fallback — so the summary's controls stay absent.
    expect(container.textContent).not.toContain("Pause all");
    expect(container.textContent).not.toContain(
      "Describe a task in chat to start one.",
    );
  });
});
