/** Verifies JoinPage waits for its active identity read before destroying the SSO session. */
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
  resolveJoinAuthToken: () => "steward-token",
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
