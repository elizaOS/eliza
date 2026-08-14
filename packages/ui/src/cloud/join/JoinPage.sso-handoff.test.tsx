/** Verifies that managed-app /join completes the PKCE SSO bridge before resolving the account-native personal Eliza. */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://cloud.eliza.app/join"}

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";

const { authenticatedRef, runJoinFlowMock } = vi.hoisted(() => ({
  authenticatedRef: { current: false },
  runJoinFlowMock: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({
    ready: true,
    authenticated: authenticatedRef.current,
  }),
}));

vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: runJoinFlowMock,
}));

vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => "steward-token",
  resolveJoinCloudApiBase: () => "https://api.eliza.app",
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? "",
}));

import JoinPage from "./JoinPage";

const realReplace = appModeNavigation.replace;
const realAssign = appModeNavigation.assign;
let replacedUrls: string[];
let assignedUrls: string[];

beforeEach(() => {
  authenticatedRef.current = false;
  runJoinFlowMock.mockReset();
  replacedUrls = [];
  assignedUrls = [];
  appModeNavigation.replace = (url: string) => replacedUrls.push(url);
  appModeNavigation.assign = (url: string) => assignedUrls.push(url);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom exposes no Cookie Store API.
  document.cookie =
    "steward-authed=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  appModeNavigation.replace = realReplace;
  appModeNavigation.assign = realAssign;
});

describe("JoinPage managed-app SSO handoff", () => {
  it("bridges a live apex session back to /join before identity resolution", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom exposes no Cookie Store API.
    document.cookie = "steward-authed=1; path=/";
    render(<JoinPage />);

    await waitFor(() => expect(replacedUrls).toHaveLength(1));
    const bridge = new URL(replacedUrls[0]);
    expect(bridge.origin).toBe("https://eliza.app");
    expect(bridge.pathname).toBe("/auth/bridge");
    expect(bridge.searchParams.get("returnTo")).toBe("/join");
    expect(bridge.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.searchParams.get("challenge")).toMatch(/^[0-9a-f]{64}$/);
    expect(runJoinFlowMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("navigate")).toBeNull();
  });

  it("falls back to the local login when no bridge session marker exists", async () => {
    render(<JoinPage />);

    expect((await screen.findByTestId("navigate")).textContent).toBe(
      "/login?returnTo=/join",
    );
    expect(replacedUrls).toEqual([]);
    expect(runJoinFlowMock).not.toHaveBeenCalled();
  });

  it("resolves identity exactly once after the bridge restores authentication", async () => {
    authenticatedRef.current = true;
    runJoinFlowMock.mockResolvedValue({ agentId: "agent-1" });
    render(<JoinPage />);

    await waitFor(() => expect(runJoinFlowMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assignedUrls).toEqual(["/"]));
    expect(replacedUrls).toEqual([]);
  });
});
