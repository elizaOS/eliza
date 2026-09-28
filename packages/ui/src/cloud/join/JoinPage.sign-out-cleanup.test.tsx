/**
 * Verifies JoinPage sign-out and session ownership: it waits for its active
 * identity read before destroying the SSO session, issues exactly one logout
 * per sign-out, and never dispatches Dedicated activation after the signed-in
 * account changes during the quote review.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runJoinFlowMock = vi.hoisted(() => vi.fn());
const signOutMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const replaceMock = vi.hoisted(() => vi.fn());
const joinSession = vi.hoisted(() => ({
  token: "steward-token" as string | null,
}));

vi.mock("react-router-dom", () => ({ Navigate: () => null }));
vi.mock("../../api", () => ({ client: {} }));
vi.mock("../../config/boot-config-store", () => ({
  getBootConfig: () => ({}),
}));
vi.mock("../../state/persistence", () => ({
  clearPersistedActiveServer: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: vi.fn(),
}));
vi.mock("../app-mode/app-mode", () => ({
  appModeNavigation: { assign: vi.fn(), replace: replaceMock },
}));
vi.mock("../billing-console", () => ({
  openCloudBillingConsole: vi.fn(() => Promise.resolve()),
}));
vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));
vi.mock("../sso-bridge/sso-bridge", () => ({
  clearSsoLoggedOut: vi.fn(),
  redirectToSsoBridge: vi.fn(() => Promise.resolve(false)),
  shouldAutoBridgeToSso: vi.fn(() => false),
  signOutFromSsoBridgedHost: signOutMock,
}));
vi.mock("./lib/apex-app-handoff", () => ({
  resolveApexJoinHandoff: () => null,
}));
vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => joinSession.token,
  resolveJoinCloudApiBase: () => "https://api.eliza.app",
}));
vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: (...args: unknown[]) => runJoinFlowMock(...args),
}));
vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));

import JoinPage from "./JoinPage";

function connectedResult() {
  return {
    personalElizaId: "personal:00000000-0000-5000-8000-000000000001",
    agentId: "personal:00000000-0000-5000-8000-000000000001",
    activeAgentId: "shared-runtime",
    agentName: "Eliza",
    apiBase: "https://api.eliza.app/api/v1/eliza/agents/shared-runtime",
    runtime: "shared" as const,
  };
}

describe("JoinPage sign-out cleanup ownership", () => {
  beforeEach(() => {
    runJoinFlowMock.mockReset();
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
    replaceMock.mockClear();
    joinSession.token = "steward-token";
  });

  afterEach(() => {
    cleanup();
  });

  it("waits for the active join to settle before destroying the SSO session", async () => {
    let finishJoin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    runJoinFlowMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishJoin = resolve;
        }),
    );
    render(<JoinPage />);
    await waitFor(() => expect(runJoinFlowMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOutMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");

    await act(async () => {
      finishJoin?.(connectedResult());
    });
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("issues exactly one hosted logout when Sign out is activated twice", async () => {
    runJoinFlowMock.mockRejectedValue(new Error("agent unavailable"));
    let finishLogout!: () => void;
    signOutMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLogout = resolve;
        }),
    );
    render(<JoinPage />);
    await screen.findByText("agent unavailable");

    const button = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishLogout();
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("does not dispatch Dedicated activation after the account changes during quote review", async () => {
    const activationPost = vi.fn();
    runJoinFlowMock.mockImplementation(
      async (args: {
        signal: AbortSignal;
        requestDedicatedActivationConfirmation: (
          quote: Record<string, unknown>,
          context: { signal?: AbortSignal },
        ) => Promise<unknown>;
      }) => {
        const decision = await args.requestDedicatedActivationConfirmation(
          {
            quoteId: "a".repeat(64),
            dailyRateUsd: 1,
            hourlyRateUsd: 0.05,
            balanceUsd: 10,
            minimumBalanceUsd: 5,
            minimumActivationChargeUsd: 0.5,
          },
          { signal: args.signal },
        );
        args.signal.throwIfAborted();
        if (decision) activationPost();
        return connectedResult();
      },
    );
    render(<JoinPage />);
    await screen.findByTestId("dedicated-activation-review");

    // Another tab signs in as a different account while the quote is open.
    joinSession.token = "other-account-token";
    await act(async () => {
      window.dispatchEvent(new Event("storage"));
    });

    await screen.findByText(/Your Eliza Cloud sign-in changed/);
    expect(activationPost).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dedicated-activation-review")).toBeNull();
  });

  it("keeps the user on a retryable error state when hosted logout is refused", async () => {
    runJoinFlowMock.mockRejectedValue(new Error("agent unavailable"));
    signOutMock.mockRejectedValue(
      new Error("Eliza Cloud could not end the browser session (403)."),
    );
    render(<JoinPage />);
    await screen.findByText("agent unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await screen.findByRole("heading", { name: "Couldn't sign out" });
    await screen.findByText("Could not sign out safely. Please try again.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });
});
