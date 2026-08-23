// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  authenticated: true,
  firstRunComplete: undefined as boolean | undefined,
  tutorialActive: false,
}));

const priming = vi.hoisted(() => ({
  hasPrimedPermissions: vi.fn(() => false),
  markPermissionsPrimed: vi.fn(),
  resolvePrimingSet: vi.fn(() => ["microphone"]),
}));

vi.mock("../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => fixture.authenticated,
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({ firstRunComplete: fixture.firstRunComplete }),
}));

vi.mock("../../tutorial/tutorial-service", () => ({
  useTutorial: () => ({ active: fixture.tutorialActive }),
}));

vi.mock("./permission-priming", () => priming);

vi.mock("./PermissionPrimingModal", () => ({
  PermissionPrimingModal: () => (
    <div data-testid="permission-priming-modal">Set up Eliza</div>
  ),
}));

import { PermissionPrimingOverlay } from "./PermissionPrimingOverlay";

describe("PermissionPrimingOverlay", () => {
  beforeEach(() => {
    fixture.authenticated = true;
    fixture.firstRunComplete = undefined;
    fixture.tutorialActive = false;
    priming.hasPrimedPermissions.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not cover a restored session or newly opened desktop view", () => {
    fixture.firstRunComplete = true;
    render(<PermissionPrimingOverlay />);

    expect(screen.queryByTestId("permission-priming-modal")).toBeNull();
  });

  it("opens after this surface observes onboarding complete", () => {
    fixture.firstRunComplete = false;
    const view = render(<PermissionPrimingOverlay />);
    expect(screen.queryByTestId("permission-priming-modal")).toBeNull();

    fixture.firstRunComplete = true;
    view.rerender(<PermissionPrimingOverlay />);

    expect(screen.getByTestId("permission-priming-modal").textContent).toBe(
      "Set up Eliza",
    );
  });

  it("waits for the tutorial without losing the observed completion", () => {
    fixture.firstRunComplete = false;
    fixture.tutorialActive = true;
    const view = render(<PermissionPrimingOverlay />);

    fixture.firstRunComplete = true;
    view.rerender(<PermissionPrimingOverlay />);
    expect(screen.queryByTestId("permission-priming-modal")).toBeNull();

    fixture.tutorialActive = false;
    view.rerender(<PermissionPrimingOverlay />);
    expect(screen.getByTestId("permission-priming-modal")).toBeTruthy();
  });
});
