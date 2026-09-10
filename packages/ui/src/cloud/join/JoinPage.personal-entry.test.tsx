/** Exercises the rendered join page, real join controller and persistence with a simulated identity-read transport. No provider or runtime is contacted. */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import { loadPersistedActiveServer } from "../../state/persistence";
import JoinPage from "./JoinPage";
import type { JoinFlowResult } from "./lib/run-join-flow";

vi.mock("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));
vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => "join-fixture-token",
  resolveJoinCloudApiBase: () => "https://api.eliza.app",
}));
vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: Record<string, unknown>) =>
    String(options?.defaultValue ?? _key),
}));
vi.mock("./lib/apex-app-handoff", () => ({
  resolveApexJoinHandoff: () => null,
}));

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const DEDICATED_ID = "00000000-0000-4000-8000-000000000099";
function selection(runtime: "shared" | "dedicated"): JoinFlowResult {
  const activeAgentId = runtime === "shared" ? PERSONAL_ID : DEDICATED_ID;
  return {
    personalElizaId: PERSONAL_ID,
    agentId: PERSONAL_ID,
    activeAgentId,
    agentName: "Eliza",
    apiBase: `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(activeAgentId)}/proxy`,
    runtime,
  };
}

describe("JoinPage read-only personal entry", () => {
  beforeEach(() => {
    localStorage.clear();
    client.setBaseUrl(null);
    client.setToken(null);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected HTTP during join fixture"),
    );
    vi.spyOn(client, "ensurePersonalDedicatedEliza").mockRejectedValue(
      new Error("Entry must not activate Dedicated"),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    client.setBaseUrl(null);
    client.setToken(null);
  });

  it.each(["shared", "dedicated"] as const)(
    "opens the existing %s binding without an adoption or paid activation step",
    async (runtime) => {
      const selected = selection(runtime);
      const read = vi
        .spyOn(client, "getPersonalSharedEliza")
        .mockResolvedValue(selected);
      render(<JoinPage />);
      expect((await screen.findByTestId("navigate")).textContent).toBe("/");
      expect(read).toHaveBeenCalledTimes(1);
      expect(loadPersistedActiveServer()).toMatchObject({
        id: `cloud:${PERSONAL_ID}`,
        cloudRuntime: runtime,
        cloudRuntimeAgentId: selected.activeAgentId,
        apiBase: selected.apiBase,
      });
      expect(client.getBaseUrl()).toBe(selected.apiBase);
      expect(client.getRestAuthToken()).toBe("join-fixture-token");
      expect(screen.queryByTestId("dedicated-adoption-review")).toBeNull();
      expect(client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("announces a failed identity read and retries only after the user asks", async () => {
    const read = vi
      .spyOn(client, "getPersonalSharedEliza")
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValue(selection("shared"));
    render(<JoinPage />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Identity temporarily unavailable",
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(loadPersistedActiveServer()).toBeNull();
    expect(screen.queryByTestId("navigate")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("navigate");
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not persist or bind a late identity response after leaving the page", async () => {
    let release!: (value: JoinFlowResult) => void;
    const read = vi.spyOn(client, "getPersonalSharedEliza").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<JoinPage />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toBeTruthy();
    view.unmount();
    expect(read.mock.calls[0][0].signal?.aborted).toBe(true);
    await act(async () => release(selection("shared")));
    expect(loadPersistedActiveServer()).toBeNull();
    expect(client.getRestAuthToken()).toBeNull();
    expect(client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
