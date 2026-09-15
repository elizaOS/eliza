/** Verifies the join screen gives credit-gated accounts a working billing recovery path. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openCloudBillingConsole: vi.fn(() => Promise.resolve(true)),
  runJoinFlow: vi.fn(),
}));

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

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={["/join"]}>
      <Routes>
        <Route path="/join" element={<JoinPage />} />
        <Route path="/" element={<h1>Connected chat</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("JoinPage Dedicated credit gate", () => {
  beforeEach(() => {
    mocks.openCloudBillingConsole.mockReset();
    mocks.openCloudBillingConsole.mockResolvedValue(true);
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
    renderJoin();

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
      .mockResolvedValueOnce({
        personalElizaId: "personal:credit-user",
        agentId: "personal:credit-user",
        activeAgentId: "dedicated-credit-user",
        agentName: "Eliza",
        apiBase: "https://dedicated-credit-user.cloud.eliza.app",
        runtime: "dedicated",
      });
    renderJoin();

    await screen.findByRole("button", { name: "Add credits" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("heading", { name: "Connected chat" });
    expect(mocks.runJoinFlow).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
  });
  it("shows a declined billing launch and permits another attempt", async () => {
    mocks.openCloudBillingConsole.mockResolvedValueOnce(false);
    renderJoin();
    fireEvent.click(await screen.findByRole("button", { name: "Add credits" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not open billing",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.openCloudBillingConsole).toHaveBeenCalledTimes(2);
  });
  it("handles a rejected platform launch without losing credit recovery", async () => {
    mocks.openCloudBillingConsole.mockRejectedValueOnce(
      new Error("Native browser unavailable"),
    );
    renderJoin();
    fireEvent.click(await screen.findByRole("button", { name: "Add credits" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not open billing",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.openCloudBillingConsole).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate billing windows while the platform launch is pending", async () => {
    let finish: (opened: boolean) => void = () => {
      throw new Error("Billing launch has not started");
    };
    mocks.openCloudBillingConsole.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    renderJoin();
    const add = await screen.findByRole("button", { name: "Add credits" });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(add).toHaveProperty("disabled", true);
    expect(mocks.openCloudBillingConsole).toHaveBeenCalledOnce();
    finish(true);
    await waitFor(() => expect(add).toHaveProperty("disabled", false));
  });
});
