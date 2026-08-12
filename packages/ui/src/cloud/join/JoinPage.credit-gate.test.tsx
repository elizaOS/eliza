/** Verifies JoinPage's credit-gate (402) surface through the package harness. */
// @vitest-environment jsdom

/**
 * A join flow that fails with the Cloud's canonical insufficient-credits 402
 * (welcome bonus withheld by the per-IP daily cap) must render the friendly
 * credit-gate state — the server's explanation plus an add-funds path — not
 * the generic "Couldn't connect to your agent" + Retry dead end (the bare-402
 * regression signature from the 2026-08-09 staging scramble). Any other
 * failure keeps the pre-existing generic error state.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runJoinFlowMock = vi.hoisted(() => vi.fn());
const openBillingMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("react-router-dom", () => ({
  Navigate: () => null,
}));

vi.mock("../../api", () => ({ client: {} }));

vi.mock("../../state/persistence", () => ({
  clearPersistedActiveServer: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: vi.fn(),
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));

vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => "steward-token",
  resolveJoinCloudApiBase: () => "https://elizacloud.ai",
}));

vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: (...args: unknown[]) => runJoinFlowMock(...args),
}));

vi.mock("../billing-console", () => ({
  openCloudBillingConsole: openBillingMock,
}));

import JoinPage from "./JoinPage";

const WITHHELD_MESSAGE =
  "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.";

function creditGate402(body: Record<string, unknown>): Error {
  return Object.assign(
    new Error(`Cloud request failed (402): ${String(body.error ?? "")}`),
    { status: 402, data: body },
  );
}

describe("JoinPage credit-gate (402) surface", () => {
  beforeEach(() => {
    runJoinFlowMock.mockReset();
    openBillingMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the withheld-bonus explanation + add-funds CTA for the capped-signup 402", async () => {
    runJoinFlowMock.mockRejectedValue(
      creditGate402({
        success: false,
        code: "insufficient_credits",
        error: WITHHELD_MESSAGE,
        requiredBalance: 0.1,
        currentBalance: 0,
        welcomeBonusWithheld: true,
        welcomeBonusWithheldReason: "ip_daily_cap",
      }),
    );

    render(<JoinPage />);
    await act(async () => {});

    expect(screen.getByTestId("join-credit-gate")).toBeTruthy();
    expect(screen.getByText("Welcome credit unavailable")).toBeTruthy();
    expect(screen.getByText(WITHHELD_MESSAGE)).toBeTruthy();
    // The per-network reassurance only shows for the withheld case.
    expect(
      screen.getByText(
        "This limit is per network and resets daily. Your account itself is fine.",
      ),
    ).toBeTruthy();
    // No generic dead-end copy.
    expect(screen.queryByText("Couldn't connect to your agent")).toBeNull();

    const cta = screen.getByRole("button", { name: "Add funds" });
    act(() => {
      cta.click();
    });
    expect(openBillingMock).toHaveBeenCalledTimes(1);
  });

  it("renders the plain add-funds state for a drained-org 402 (no withheld flag)", async () => {
    runJoinFlowMock.mockRejectedValue(
      creditGate402({
        success: false,
        code: "insufficient_credits",
        error: "Insufficient credits. Please add funds at /dashboard/billing.",
        requiredBalance: 0.1,
        currentBalance: 0,
      }),
    );

    render(<JoinPage />);
    await act(async () => {});

    expect(screen.getByTestId("join-credit-gate")).toBeTruthy();
    expect(screen.getByText("Add funds to start your agent")).toBeTruthy();
    expect(
      screen.queryByText(
        "This limit is per network and resets daily. Your account itself is fine.",
      ),
    ).toBeNull();
  });

  it("does not claim a daily network cap when the grant count was unavailable", async () => {
    runJoinFlowMock.mockRejectedValue(
      creditGate402({
        success: false,
        code: "insufficient_credits",
        error:
          "Welcome credit could not be verified. Add funds to start an agent.",
        currentBalance: 0,
        welcomeBonusWithheld: true,
        welcomeBonusWithheldReason: "count_unavailable",
      }),
    );

    render(<JoinPage />);
    await act(async () => {});

    expect(screen.getByText("Welcome credit unavailable")).toBeTruthy();
    expect(
      screen.queryByText(
        "This limit is per network and resets daily. Your account itself is fine.",
      ),
    ).toBeNull();
  });

  it("keeps the generic error state for non-402 failures", async () => {
    runJoinFlowMock.mockRejectedValue(new Error("network down"));

    render(<JoinPage />);
    await act(async () => {});

    expect(screen.queryByTestId("join-credit-gate")).toBeNull();
    expect(screen.getByText("Couldn't connect to your agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
