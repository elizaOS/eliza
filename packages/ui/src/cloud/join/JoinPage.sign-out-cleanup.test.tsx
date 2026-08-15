/**
 * Verifies JoinPage retains auth until fresh-agent compensation is owned. The
 * page-level sign-out owner must await the active join controller. A
 * successful compensation permits SSO destruction; an AggregateError means
 * cleanup is unowned, keeps the user signed in, and exposes an explicit
 * sign-out-anyway decision. All network and navigation seams are deterministic.
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
    agentId: "agent-new",
    agentName: "Eliza",
    apiBase: "https://agent-new.cloud.eliza.app",
    created: true,
    dedicated: true,
  };
}

describe("JoinPage sign-out cleanup ownership", () => {
  beforeEach(() => {
    runJoinFlowMock.mockReset();
    signOutMock.mockClear();
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

  it("keeps auth on cleanup failure and requires an explicit sign-out-anyway action", async () => {
    runJoinFlowMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(
                new AggregateError(
                  [signal.reason, new Error("delete job failed")],
                  "Join was cancelled after create, and compensating deletion failed",
                ),
              );
            },
            { once: true },
          );
        }),
    );
    render(<JoinPage />);
    await waitFor(() => expect(runJoinFlowMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByText(
        /couldn't finish removing the newly created agent/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/delete job failed/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.className).toContain("text-bg");
    expect(retry.className).toContain("hover:!text-bg");
    expect(signOutMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");

    fireEvent.click(screen.getByRole("button", { name: "Sign out anyway" }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });
});
