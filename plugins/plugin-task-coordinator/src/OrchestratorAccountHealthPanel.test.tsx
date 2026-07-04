// @vitest-environment jsdom
//
// The account-health panel (#9960) surfaces the multi-account pool's per-account
// health + the server readiness verdict inside the orchestrator workbench (the
// same accounts view the chat sidebar reuses). These tests pin: it fetches the
// four sources, renders the reused accounts view, and renders the readiness
// banner verbatim from the server DTO (ready vs degraded-with-problems).

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = {
  listAccounts: vi.fn(),
  getOrchestratorAccounts: vi.fn(),
  getOrchestratorRooms: vi.fn(),
  getOrchestratorAccountReadiness: vi.fn(),
};

vi.mock("@elizaos/ui", () => ({
  client: {
    listAccounts: () => calls.listAccounts(),
    getOrchestratorAccounts: () => calls.getOrchestratorAccounts(),
    getOrchestratorRooms: () => calls.getOrchestratorRooms(),
    getOrchestratorAccountReadiness: () =>
      calls.getOrchestratorAccountReadiness(),
  },
}));

// Stub the reused presentational view so the test targets THIS panel's wiring.
vi.mock("@elizaos/ui/components", () => ({
  OrchestratorAccountsView: (props: {
    overview?: { strategy?: string } | null;
    onConnect?: () => void;
  }) => (
    <div
      data-testid="accounts-view"
      data-strategy={props.overview?.strategy ?? ""}
    />
  ),
}));

import { OrchestratorAccountHealthPanel } from "./OrchestratorAccountHealthPanel";

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.listAccounts.mockResolvedValue({ providers: [] });
  calls.getOrchestratorAccounts.mockResolvedValue({
    strategy: "least-used",
    availability: {},
    assignments: [],
  });
  calls.getOrchestratorRooms.mockResolvedValue({ rooms: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrchestratorAccountHealthPanel (#9960)", () => {
  it("renders the accounts view + a ready banner when the pool is ready", async () => {
    calls.getOrchestratorAccountReadiness.mockResolvedValue({
      ready: true,
      rotation: false,
      required: 1,
      providers: [],
      problems: [],
    });

    render(React.createElement(OrchestratorAccountHealthPanel));

    await waitFor(() =>
      expect(screen.getByTestId("accounts-view")).toBeTruthy(),
    );
    const banner = screen.getByTestId("orchestrator-account-readiness");
    expect(banner.getAttribute("data-ready")).toBe("true");
    expect(
      screen.getByTestId("accounts-view").getAttribute("data-strategy"),
    ).toBe("least-used");
  });

  it("renders the degraded verdict + problems verbatim when the pool is not ready", async () => {
    calls.getOrchestratorAccountReadiness.mockResolvedValue({
      ready: false,
      rotation: false,
      required: 1,
      providers: [],
      problems: ["codex: 0 healthy account(s), need >= 1 (none connected)"],
    });

    render(React.createElement(OrchestratorAccountHealthPanel));

    const banner = await screen.findByTestId("orchestrator-account-readiness");
    expect(banner.getAttribute("data-ready")).toBe("false");
    expect(banner.textContent).toContain("codex");
    expect(banner.textContent).toContain("need >= 1");
  });

  it("calls all four data sources once on mount", async () => {
    calls.getOrchestratorAccountReadiness.mockResolvedValue({
      ready: true,
      rotation: false,
      required: 1,
      providers: [],
      problems: [],
    });

    render(React.createElement(OrchestratorAccountHealthPanel));

    await waitFor(() =>
      expect(screen.getByTestId("accounts-view")).toBeTruthy(),
    );
    expect(calls.listAccounts).toHaveBeenCalledTimes(1);
    expect(calls.getOrchestratorAccounts).toHaveBeenCalledTimes(1);
    expect(calls.getOrchestratorRooms).toHaveBeenCalledTimes(1);
    expect(calls.getOrchestratorAccountReadiness).toHaveBeenCalledTimes(1);
  });
});
