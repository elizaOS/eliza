/** Verifies /join opens the existing personal runtime without presenting a paid activation flow. */
// @vitest-environment jsdom

import { STEWARD_SESSION_CHANGE_EVENT } from "@elizaos/shared/steward-session-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JoinFlowResult } from "./lib/run-join-flow";

const state = vi.hoisted(() => ({
  token: "steward-token",
  client: {
    getPersonalSharedEliza: vi.fn(),
    ensurePersonalDedicatedEliza: vi.fn(() => {
      throw new Error("Paid activation is not a join operation");
    }),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
  },
  saveServer: vi.fn(),
  saveFirstRun: vi.fn(),
  publishHandoff: vi.fn(),
}));
vi.mock("../../api", () => ({ client: state.client }));
vi.mock("../../state/persistence", () => ({
  savePersistedActiveServer: state.saveServer,
  savePersistedFirstRunComplete: state.saveFirstRun,
}));
vi.mock("../app-mode/use-personal-entry", () => ({
  publishPersonalEntryHandoff: state.publishHandoff,
}));
vi.mock("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));
vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => state.token,
  resolveJoinCloudApiBase: () => "https://api.eliza.app",
}));
vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: Record<string, unknown>) =>
    String(options?.defaultValue ?? _key),
}));
vi.mock("./lib/apex-app-handoff", () => ({
  resolveApexJoinHandoff: () => null,
}));

import JoinPage from "./JoinPage";

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
function existingRuntime(runtime: "shared" | "dedicated"): JoinFlowResult {
  const activeAgentId =
    runtime === "shared" ? PERSONAL_ID : "00000000-0000-4000-8000-000000000099";
  return {
    personalElizaId: PERSONAL_ID,
    agentId: PERSONAL_ID,
    activeAgentId,
    agentName: "Eliza",
    runtime,
    apiBase:
      runtime === "shared"
        ? `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`
        : `https://${activeAgentId}.cloud.eliza.app`,
  };
}
describe("JoinPage existing personal runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.token = "steward-token";
    state.client.getPersonalSharedEliza.mockReset();
  });
  afterEach(cleanup);
  it.each(["shared", "dedicated"] as const)(
    "opens existing %s through the real join controller without paid activation",
    async (runtime) => {
      const selected = existingRuntime(runtime);
      state.client.getPersonalSharedEliza.mockResolvedValue(selected);
      render(<JoinPage />);
      expect((await screen.findByTestId("navigate")).textContent).toBe("/");
      expect(state.client.getPersonalSharedEliza).toHaveBeenCalledTimes(1);
      expect(state.client.getPersonalSharedEliza).toHaveBeenCalledWith({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        signal: expect.any(AbortSignal),
      });
      expect(state.client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
      expect(state.saveServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `cloud:${PERSONAL_ID}`,
          cloudRuntimeAgentId: selected.activeAgentId,
          cloudRuntime: runtime,
        }),
      );
      expect(state.publishHandoff).toHaveBeenCalledWith(
        "steward-token",
        selected,
      );
      expect(state.saveFirstRun).toHaveBeenCalledWith(true);
      expect(screen.queryByText("Start Dedicated")).toBeNull();
      expect(screen.queryByText("Add credits")).toBeNull();
    },
  );
  it("does not publish or persist a cancelled identity resolution after unmount", async () => {
    let finish: ((result: JoinFlowResult) => void) | undefined;
    state.client.getPersonalSharedEliza.mockImplementation(
      () =>
        new Promise<JoinFlowResult>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<JoinPage />);
    await waitFor(() =>
      expect(state.client.getPersonalSharedEliza).toHaveBeenCalledTimes(1),
    );
    const signal = state.client.getPersonalSharedEliza.mock.calls[0]?.[0]
      .signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish?.(existingRuntime("shared"));
    });
    expect(state.client.setBaseUrl).not.toHaveBeenCalled();
    expect(state.client.setToken).not.toHaveBeenCalled();
    expect(state.saveServer).not.toHaveBeenCalled();
    expect(state.saveFirstRun).not.toHaveBeenCalled();
    expect(state.publishHandoff).not.toHaveBeenCalled();
    expect(state.client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
  });

  it.each([STEWARD_SESSION_CHANGE_EVENT, "storage"])(
    "refuses an account switch during resolution signalled by %s",
    async (eventName) => {
      state.token = `header.${btoa(JSON.stringify({ sub: "original-owner" }))}.synthetic`;
      let finish: ((result: JoinFlowResult) => void) | undefined;
      state.client.getPersonalSharedEliza.mockImplementation(
        () =>
          new Promise<JoinFlowResult>((resolve) => {
            finish = resolve;
          }),
      );
      render(<JoinPage />);
      await waitFor(() =>
        expect(state.client.getPersonalSharedEliza).toHaveBeenCalledTimes(1),
      );
      const signal = state.client.getPersonalSharedEliza.mock.calls[0]?.[0]
        .signal as AbortSignal;
      state.token = `header.${btoa(JSON.stringify({ sub: "different-owner" }))}.synthetic`;
      act(() => window.dispatchEvent(new Event(eventName)));
      expect(signal.aborted).toBe(true);
      await act(async () => {
        finish?.(existingRuntime("shared"));
      });
      expect(
        await screen.findByText(/sign-in changed while your agent was opening/),
      ).toBeTruthy();
      expect(state.saveServer).not.toHaveBeenCalled();
      expect(state.client.setToken).not.toHaveBeenCalled();
      expect(state.publishHandoff).not.toHaveBeenCalled();
    },
  );

  it("revalidates the owner before persistence when no session event arrives", async () => {
    state.token = `header.${btoa(JSON.stringify({ sub: "original-owner" }))}.synthetic`;
    let finish: ((result: JoinFlowResult) => void) | undefined;
    state.client.getPersonalSharedEliza.mockImplementation(
      () =>
        new Promise<JoinFlowResult>((resolve) => {
          finish = resolve;
        }),
    );
    render(<JoinPage />);
    await waitFor(() =>
      expect(state.client.getPersonalSharedEliza).toHaveBeenCalledTimes(1),
    );
    state.token = `header.${btoa(JSON.stringify({ sub: "different-owner" }))}.synthetic`;
    await act(async () => {
      finish?.(existingRuntime("shared"));
    });
    expect(
      await screen.findByText(/sign-in changed while your agent was opening/),
    ).toBeTruthy();
    expect(state.saveServer).not.toHaveBeenCalled();
    expect(state.client.setBaseUrl).not.toHaveBeenCalled();
    expect(state.publishHandoff).not.toHaveBeenCalled();
  });

  it("allows a refreshed access token for the same owner without cancelling valid resolution", async () => {
    const token = (suffix: string) =>
      `header.${btoa(JSON.stringify({ sub: "same-owner" }))}.${suffix}`;
    state.token = token("original");
    let finish: ((result: JoinFlowResult) => void) | undefined;
    state.client.getPersonalSharedEliza.mockImplementation(
      () =>
        new Promise<JoinFlowResult>((resolve) => {
          finish = resolve;
        }),
    );
    render(<JoinPage />);
    await waitFor(() =>
      expect(state.client.getPersonalSharedEliza).toHaveBeenCalledTimes(1),
    );
    const signal = state.client.getPersonalSharedEliza.mock.calls[0]?.[0]
      .signal as AbortSignal;
    state.token = token("refreshed");
    act(() => window.dispatchEvent(new Event("steward-token-sync")));
    expect(signal.aborted).toBe(false);
    await act(async () => {
      finish?.(existingRuntime("shared"));
    });
    expect((await screen.findByTestId("navigate")).textContent).toBe("/");
    expect(state.saveServer).toHaveBeenCalledTimes(1);
    expect(state.publishHandoff).toHaveBeenCalledTimes(1);
    expect(state.client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
  });
});
