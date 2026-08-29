/** Verifies the join screen gives credit-gated accounts a working billing recovery path. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openCloudBillingConsole: vi.fn(() => Promise.resolve(true)),
  runJoinFlow: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ Navigate: () => null }));
vi.mock("../../api", () => ({ client: {} }));
vi.mock("../../state/persistence", () => ({
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: vi.fn(),
}));
vi.mock("../app-mode/app-mode", () => ({
  appModeNavigation: { assign: vi.fn(), replace: vi.fn() },
}));
vi.mock("../billing-console", () => ({
  openCloudBillingConsole: mocks.openCloudBillingConsole,
}));
vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));
vi.mock("../sso-bridge/sso-bridge", () => ({
  clearSsoLoggedOut: vi.fn(),
  redirectToSsoBridge: vi.fn(() => Promise.resolve(false)),
  shouldAutoBridgeToSso: vi.fn(() => false),
  signOutFromSsoBridgedHost: vi.fn(() => Promise.resolve()),
}));
vi.mock("./lib/apex-app-handoff", () => ({
  resolveApexJoinHandoff: () => null,
}));
vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => "steward-token",
  resolveJoinCloudApiBase: () => "https://api-staging.eliza.app/api/v1",
}));
vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: (...args: unknown[]) => mocks.runJoinFlow(...args),
}));
vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));

import JoinPage from "./JoinPage";

describe("JoinPage Dedicated credit gate", () => {
  beforeEach(() => {
    mocks.openCloudBillingConsole.mockClear();
    mocks.runJoinFlow.mockReset();
    mocks.runJoinFlow.mockRejectedValue(
      Object.assign(
        new Error("At least $0.72 in hosting credit is required."),
        {
          status: 402,
        },
      ),
    );
  });

  afterEach(cleanup);

  it("opens the billing console from the credit-specific recovery action", async () => {
    render(<JoinPage />);

    const addCredits = await screen.findByRole("button", {
      name: "Add credits",
    });
    fireEvent.click(addCredits);

    await waitFor(() =>
      expect(mocks.openCloudBillingConsole).toHaveBeenCalledWith(
        "https://api-staging.eliza.app/api/v1",
      ),
    );
  });

  it("retries Dedicated onboarding after credits are added", async () => {
    mocks.runJoinFlow
      .mockRejectedValueOnce(
        Object.assign(
          new Error("At least $0.72 in hosting credit is required."),
          { status: 402 },
        ),
      )
      .mockResolvedValueOnce({ runtime: "dedicated" });
    render(<JoinPage />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Try again",
      }),
    );

    await waitFor(() => expect(mocks.runJoinFlow).toHaveBeenCalledTimes(2));
  });
});
