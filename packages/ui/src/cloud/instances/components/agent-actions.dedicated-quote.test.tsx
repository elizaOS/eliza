/** Verifies that Dedicated activation renders and confirms only the server quote. */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchStewardSessionChange } from "../../../events/steward-session-event";
import {
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../../shell/StewardProviderShared";
import { ElizaAgentActions } from "./agent-actions";
import { ElizaConnectButton } from "./eliza-connect-button";

const apiWithStatus = vi.hoisted(() => vi.fn());
const readCloudBearerToken = vi.hoisted(() => vi.fn());
const ensureCloudSessionForRepair = vi.hoisted(() => vi.fn());
const runSharedToDedicatedUpgradeHandoff = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({
  getBaseUrl: vi.fn(),
}));
const silentlyRepointToDedicated = vi.hoisted(() => vi.fn());
const directCloudSharedAgentIdFromBase = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiWithStatus,
  readCloudBearerToken,
}));

vi.mock("../../../state/cloud-session-refresh-for-repair", () => ({
  ensureCloudSessionForRepair,
}));

vi.mock("sonner", () => ({ toast }));

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: Record<string, unknown>) => {
    let text = String(options?.defaultValue ?? _key);
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));

vi.mock("../lib/use-job-poller", () => ({
  useJobPoller: () => ({
    getStatus: () => null,
    isActive: () => false,
    track: vi.fn(),
  }),
}));

vi.mock("../lib/open-web-ui", () => ({
  openWebUIWithPairing: vi.fn(),
}));

vi.mock("../../handoff/start-tier-upgrade", () => ({
  runSharedToDedicatedUpgradeHandoff,
}));

vi.mock("../../handoff/silent-repoint", () => ({
  silentlyRepointToDedicated,
}));

vi.mock("../../../utils/cloud-agent-base", () => ({
  directCloudSharedAgentIdFromBase,
}));

vi.mock("../../../api", () => ({
  client,
  ElizaClient: class {},
}));

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const QUOTE = {
  quoteId: "a".repeat(64),
  quoteVersion: "personal-dedicated-v1" as const,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 300_000,
  sourceAgentId: PERSONAL_ID,
  hourlyRateUsd: 0.01,
  dailyRateUsd: 0.24,
  minimumBalanceUsd: 0.72,
  minimumRunwayDays: 3,
  balanceUsd: 1.25,
  deficitUsd: 0,
  canActivate: true,
  requiresConfirmation: true as const,
  action: "activate_dedicated" as const,
  activation: { state: "available" as const },
};

function sessionValue(userId: string | null): LocalStewardAuthValue {
  return {
    isAuthenticated: userId !== null,
    isLoading: false,
    user: userId ? { id: userId } : null,
    session: null,
    signOut: () => null,
    getToken: () => null,
    verifyEmailCallback: async () => ({ token: "" }),
  };
}

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <LocalStewardAuthContext.Provider value={sessionValue("account-a")}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </LocalStewardAuthContext.Provider>,
  );
}

function renderActions() {
  renderWithQueryClient(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ElizaAgentActions
              agentId={PERSONAL_ID}
              executionTier="shared"
              status="running"
            />
          }
        />
        <Route
          path="/cloud/agents/:agentId"
          element={<p>Dedicated agent destination</p>}
        />
        <Route path="/cloud/billing" element={<p>Billing destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderChangingAgent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let userId: string | null = "account-a";
  function view(agentId: string, status = "running") {
    return (
      <LocalStewardAuthContext.Provider value={sessionValue(userId)}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ElizaAgentActions
              agentId={agentId}
              executionTier="shared"
              status={status}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </LocalStewardAuthContext.Provider>
    );
  }
  const result = render(view(PERSONAL_ID));
  return {
    ...result,
    changeAgent: (agentId: string, status?: string) =>
      result.rerender(view(agentId, status)),
    changeSession: (nextUserId: string | null) => {
      userId = nextUserId;
      result.rerender(view(PERSONAL_ID));
    },
  };
}

describe("Dedicated activation quote", () => {
  beforeEach(() => {
    QUOTE.issuedAt = Date.now();
    QUOTE.expiresAt = QUOTE.issuedAt + 300_000;
    apiWithStatus.mockReset();
    readCloudBearerToken.mockReset().mockResolvedValue("cloud-token");
    ensureCloudSessionForRepair.mockReset().mockResolvedValue(null);
    runSharedToDedicatedUpgradeHandoff.mockReset();
    client.getBaseUrl.mockReset();
    silentlyRepointToDedicated.mockReset();
    directCloudSharedAgentIdFromBase.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("withdraws an expired visible quote and fetches again only on explicit review", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(QUOTE.expiresAt);
    try {
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-confirm"));
      expect(
        await screen.findByRole("button", { name: "Review current quote" }),
      ).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
      expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
      const callsBeforeReview = apiWithStatus.mock.calls.length;
      clock.mockRestore();
      await userEvent.click(
        screen.getByRole("button", { name: "Review current quote" }),
      );
      await screen.findByRole("button", { name: "Activate Dedicated" });
      expect(apiWithStatus.mock.calls.length).toBeGreaterThan(
        callsBeforeReview,
      );
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("announces expiry while the dialog is idle without fetching or activating", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    const requestCount = apiWithStatus.mock.calls.length;
    const clock = vi.spyOn(Date, "now").mockReturnValue(QUOTE.expiresAt);
    try {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(
        screen.getByRole("button", { name: "Review current quote" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Activate Dedicated" }),
      ).toBeNull();
      expect(apiWithStatus.mock.calls).toHaveLength(requestCount);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(apiWithStatus.mock.calls).toHaveLength(requestCount);
    } finally {
      clock.mockRestore();
    }
  });

  it("rechecks expiry after the asynchronous credential read and before POST", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    const clock = vi.spyOn(Date, "now");
    readCloudBearerToken.mockImplementationOnce(async () => {
      clock.mockReturnValue(QUOTE.expiresAt);
      return "cloud-token";
    });
    try {
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-confirm"));
      expect(
        await screen.findByRole("button", { name: "Review current quote" }),
      ).toBeTruthy();
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
      expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("offers fresh review after a server-expired quote without a replacement or automatic replay", async () => {
    apiWithStatus.mockImplementation(async (_path, init) =>
      init.method === "GET"
        ? { status: 200, data: { data: QUOTE } }
        : { status: 409, data: { code: "dedicated_quote_changed" } },
    );
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );
    expect(
      await screen.findByRole("button", { name: "Review current quote" }),
    ).toBeTruthy();
    expect(
      apiWithStatus.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
    expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown version", { quoteVersion: "personal-dedicated-v999" }],
    ["missing version", { quoteVersion: undefined }],
    ["missing expiry", { expiresAt: undefined }],
    ["missing issuance", { issuedAt: undefined }],
    ["non-integer expiry", { expiresAt: 0.5 }],
    ["non-finite expiry", { expiresAt: Number.POSITIVE_INFINITY }],
    ["invalid lifetime", { issuedAt: 20, expiresAt: 10 }],
    ["invalid identifier", { quoteId: "not-a-quote" }],
    ["missing daily price", { dailyRateUsd: undefined }],
    ["non-finite price", { hourlyRateUsd: Number.NaN }],
    ["string balance", { balanceUsd: "1.25" }],
    ["negative deficit", { deficitUsd: -1 }],
    ["non-boolean permission", { canActivate: "true" }],
    ["missing confirmation requirement", { requiresConfirmation: undefined }],
    ["different action", { action: "adopt_existing_dedicated" }],
    ["unknown runtime state", { activation: { state: "unknown" } }],
    ["incomplete target", { activation: { state: "in_progress" } }],
  ])(
    "refuses a review with %s and recovers only from fresh valid terms",
    async (_label, invalid) => {
      let currentQuote = { ...QUOTE, ...invalid };
      apiWithStatus.mockImplementation(async () => ({
        status: 200,
        data: { success: true, data: currentQuote },
      }));
      renderActions();
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
      expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();

      currentQuote = QUOTE;
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      expect(
        await screen.findByRole("button", { name: "Activate Dedicated" }),
      ).toBeTruthy();
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
    },
  );

  it.each([
    ["missing version", { quoteVersion: undefined }],
    ["wrong source", { sourceAgentId: "another-agent" }],
    ["missing price", { dailyRateUsd: undefined }],
    ["unknown state", { activation: { state: "unknown" } }],
  ])(
    "does not reopen or replay an invalid changed quote with %s",
    async (_label, invalid) => {
      apiWithStatus.mockImplementation(async (_path, init) =>
        init.method === "GET"
          ? { status: 200, data: { success: true, data: QUOTE } }
          : {
              status: 409,
              data: {
                code: "dedicated_quote_changed",
                data: { ...QUOTE, quoteId: "b".repeat(64), ...invalid },
              },
            },
      );
      renderActions();
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      await userEvent.click(
        await screen.findByRole("button", { name: "Activate Dedicated" }),
      );
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(
        apiWithStatus.mock.calls.filter(([, init]) => init.method === "POST"),
      ).toHaveLength(1);
      expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(["account-b", null])(
    "invalidates visible consent when the provider account becomes %s",
    async (nextUserId) => {
      apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
      const view = renderChangingAgent();
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      await screen.findByRole("button", { name: "Activate Dedicated" });
      view.changeSession(nextUserId);
      expect(
        screen.queryByRole("button", { name: "Activate Dedicated" }),
      ).toBeNull();
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
    },
  );

  it.each(["canonical", "legacy sync", "cross-tab storage"])(
    "withdraws reviewed consent on %s session notification",
    async (kind) => {
      apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
      renderActions();
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      await screen.findByRole("button", { name: "Activate Dedicated" });
      act(() => {
        if (kind === "canonical") dispatchStewardSessionChange("cleared");
        else if (kind === "legacy sync")
          window.dispatchEvent(new Event("steward-token-sync"));
        else
          window.dispatchEvent(
            new StorageEvent("storage", { key: "steward_session_token" }),
          );
      });
      expect(
        screen.queryByRole("button", { name: "Activate Dedicated" }),
      ).toBeNull();
      expect(
        apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
      ).toBe(true);
    },
  );

  it("requires a new review if the bearer changes without a notification", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    const confirm = await screen.findByRole("button", {
      name: "Activate Dedicated",
    });
    readCloudBearerToken.mockResolvedValue("replacement-token");
    await userEvent.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(
      apiWithStatus.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(0);
    expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
  });

  it("does not send activation after session withdrawal during credential resolution", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    const confirm = await screen.findByRole("button", {
      name: "Activate Dedicated",
    });
    let finishRead!: (token: string) => void;
    readCloudBearerToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    await userEvent.click(confirm);
    await waitFor(() => expect(finishRead).toBeTypeOf("function"));
    act(() => dispatchStewardSessionChange("cleared"));
    await act(async () => {
      finishRead("cloud-token");
    });
    expect(
      apiWithStatus.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(0);
    expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
  });

  it("allows a fresh explicit review for the replacement account without activating automatically", async () => {
    let currentQuote = QUOTE;
    apiWithStatus.mockImplementation(async () => ({
      status: 200,
      data: { data: currentQuote },
    }));
    const view = renderChangingAgent();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    currentQuote = { ...QUOTE, quoteId: "b".repeat(64), balanceUsd: 9.5 };
    view.changeSession("account-b");
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    expect(
      await screen.findByText(
        "Current balance: $9.50 · Required before activation: $0.72 (3 days)",
      ),
    ).toBeTruthy();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("does not discard a review for an unrelated preference storage event", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: "unrelated-theme-preference" }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Activate Dedicated" }),
    ).toBeTruthy();
  });

  it("recovers a cookie-only handoff session before reviewing and confirming activation", async () => {
    let token: string | null = null;
    readCloudBearerToken.mockImplementation(async () => token);
    ensureCloudSessionForRepair.mockImplementation(async () => {
      token = "recovered-cloud-token";
      return token;
    });
    apiWithStatus.mockImplementation(async (_url, init) =>
      init.method === "POST"
        ? {
            status: 202,
            data: { data: { dedicatedAgentId: "dedicated-target", jobId: "job" } },
          }
        : { status: 200, data: { data: QUOTE } },
    );
    runSharedToDedicatedUpgradeHandoff.mockResolvedValue({
      status: "switched-empty",
      imported: 0,
    });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    const confirm = await screen.findByRole("button", {
      name: "Activate Dedicated",
    });
    expect(
      apiWithStatus.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(0);
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(runSharedToDedicatedUpgradeHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ authToken: "recovered-cloud-token" }),
      ),
    );
    const posts = apiWithStatus.mock.calls.filter(
      ([, init]) => init.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0][1].headers).toEqual({
      Authorization: "Bearer recovered-cloud-token",
    });
    expect(ensureCloudSessionForRepair).toHaveBeenCalledTimes(1);
  });

  it("does not offer activation when the cookie-only handoff session cannot be recovered", async () => {
    readCloudBearerToken.mockResolvedValue(null);
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await waitFor(() =>
      expect(ensureCloudSessionForRepair).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
    expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
  });

  it("does not activate or open a quote while cookie session recovery is pending", async () => {
    readCloudBearerToken.mockResolvedValue(null);
    let finishRecovery!: (token: string | null) => void;
    ensureCloudSessionForRepair.mockImplementation(
      () => new Promise((resolve) => { finishRecovery = resolve; }),
    );
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    const view = renderChangingAgent();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await waitFor(() =>
      expect(ensureCloudSessionForRepair).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    view.changeSession("account-b");
    await act(async () => finishRecovery("obsolete-recovery-token"));
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
    expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
  });

  it("discards a quote if credentials change while its response is pending", async () => {
    let resolveReview!: (value: unknown) => void;
    apiWithStatus
      .mockResolvedValueOnce({ status: 200, data: { data: QUOTE } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReview = resolve;
          }),
      );
    renderActions();
    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(2));
    readCloudBearerToken.mockResolvedValue("replacement-token");
    await act(async () => {
      resolveReview({ status: 200, data: { data: QUOTE } });
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("dismisses a quote when the selected agent changes and requires a new review", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    const view = renderChangingAgent();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    view.changeAgent("another-shared-agent");
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("discards a delayed quote from the previously selected agent", async () => {
    let resolveReview!: (value: unknown) => void;
    apiWithStatus
      .mockResolvedValueOnce({ status: 200, data: { data: QUOTE } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReview = resolve;
          }),
      )
      .mockResolvedValue({
        status: 200,
        data: { data: { ...QUOTE, sourceAgentId: "another-shared-agent" } },
      });
    const view = renderChangingAgent();
    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(2));
    view.changeAgent("another-shared-agent");
    await act(async () => {
      resolveReview({ status: 200, data: { data: QUOTE } });
    });
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    expect(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    ).toBeTruthy();
  });

  it("requires a new review when the source runtime state changes", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    const view = renderChangingAgent();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    view.changeAgent(PERSONAL_ID, "error");
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("does not restore an open confirmation from the browser back-forward cache", async () => {
    apiWithStatus.mockResolvedValue({ status: 200, data: { data: QUOTE } });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await screen.findByRole("button", { name: "Activate Dedicated" });
    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    expect(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    ).toBeTruthy();
  });

  it("rejects a quote whose source does not match the selected agent", async () => {
    apiWithStatus.mockResolvedValue({
      status: 200,
      data: { data: { ...QUOTE, sourceAgentId: "another-shared-agent" } },
    });
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it.each(["unmount", "pagehide", "agent change"] as const)(
    "does not begin handoff from a late activation response after %s",
    async (change) => {
      let resolveActivation!: (value: unknown) => void;
      apiWithStatus.mockImplementation(async (_url, init) => {
        if (init.method === "POST") {
          return new Promise((resolve) => {
            resolveActivation = resolve;
          });
        }
        return { status: 200, data: { data: QUOTE } };
      });
      const view = renderChangingAgent();
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      await userEvent.click(
        await screen.findByRole("button", { name: "Activate Dedicated" }),
      );
      await waitFor(() =>
        expect(
          apiWithStatus.mock.calls.filter(([, init]) => init.method === "POST"),
        ).toHaveLength(1),
      );
      act(() => {
        if (change === "unmount") view.unmount();
        else if (change === "agent change")
          view.changeAgent("another-shared-agent");
        else
          window.dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          );
      });
      await act(async () => {
        resolveActivation({
          status: 200,
          data: {
            data: { dedicatedAgentId: "00000000-0000-4000-8000-000000000099" },
          },
        });
      });
      expect(runSharedToDedicatedUpgradeHandoff).not.toHaveBeenCalled();
      expect(silentlyRepointToDedicated).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "Activate Dedicated" }),
      ).toBeNull();
    },
  );

  it("refreshes the price when review opens instead of presenting the mount-time quote", async () => {
    let currentQuote = QUOTE;
    apiWithStatus.mockImplementation(async () => ({
      status: 200,
      data: { success: true, data: currentQuote },
    }));
    renderActions();
    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(1));
    currentQuote = { ...QUOTE, quoteId: "b".repeat(64), balanceUsd: 2.5 };
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    expect(
      await screen.findByText(
        "Current balance: $2.50 · Required before activation: $0.72 (3 days)",
      ),
    ).toBeTruthy();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("does not reuse a cancelled review when the quote changes before reopening", async () => {
    let currentQuote = QUOTE;
    apiWithStatus.mockImplementation(async () => ({
      status: 200,
      data: { success: true, data: currentQuote },
    }));
    renderActions();
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    currentQuote = { ...QUOTE, quoteId: "c".repeat(64), balanceUsd: 3.75 };
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    expect(
      await screen.findByText(
        "Current balance: $3.75 · Required before activation: $0.72 (3 days)",
      ),
    ).toBeTruthy();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("does not offer the cached price when the fresh quote lookup fails", async () => {
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValue({
        status: 503,
        data: { error: "Quote service unavailable" },
      });
    renderActions();
    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Quote service unavailable"),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();
    expect(
      apiWithStatus.mock.calls.every(([, init]) => init.method === "GET"),
    ).toBe(true);
  });

  it("loads and renders the server-owned quote before offering activation", async () => {
    apiWithStatus.mockResolvedValue({
      status: 200,
      data: { success: true, data: QUOTE },
    });
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));

    expect(
      await screen.findByText(
        "Current balance: $1.25 · Required before activation: $0.72 (3 days)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your Shared Agent becomes a private, always-on Dedicated Agent. Dedicated hosting uses $0.24 per day ($0.01/hr) while running.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Activate Dedicated" }),
    ).toBeTruthy();
    expect(apiWithStatus).toHaveBeenCalledWith(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`,
      { method: "GET" },
    );
  });

  it("names an existing migration target as recovery and promises reuse", async () => {
    apiWithStatus.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          ...QUOTE,
          activation: {
            state: "in_progress" as const,
            dedicatedAgentId: "00000000-0000-4000-8000-000000000099",
            status: "error",
          },
        },
      },
    });
    renderActions();

    const resumeButton = await screen.findByRole("button", {
      name: "Resume Dedicated setup",
    });
    await userEvent.click(resumeButton);

    expect(
      await screen.findByRole("heading", { name: "Resume Dedicated setup?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "A Dedicated Agent already exists for this upgrade, but setup did not finish. Resuming reuses that agent — it does not create another one. Hosting uses $0.24 per day ($0.01/hr) while running.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume setup" })).toBeTruthy();
  });

  it("keeps lifecycle controls while removing the manual snapshot action", () => {
    renderWithQueryClient(
      <MemoryRouter>
        <ElizaAgentActions
          agentId="dedicated-agent"
          executionTier="dedicated-always"
          status="running"
        />
      </MemoryRouter>,
    );

    for (const name of [
      "Open Web UI",
      "Suspend Agent",
      "Deactivate Agent",
      "Delete Agent",
    ]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeTruthy();
      expect(control.className).toContain("min-h-touch");
    }
    expect(screen.queryByText("Agent Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Snapshot" })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /backup|snapshot|container|runtime|compute/i,
    );
  });

  it("keeps the detail-header Web UI launch touch-sized", () => {
    render(<ElizaConnectButton agentId="dedicated-agent" />);

    expect(
      screen.getByRole("button", { name: "Open Web UI" }).className,
    ).toContain("min-h-touch");
  });

  it("keeps shared agents persistent while offering explicit Dedicated activation", () => {
    renderActions();

    expect(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suspend Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent" })).toBeNull();
    expect(screen.queryByText("Agent Actions")).toBeNull();
  });

  it("posts the exact quote and explicit action instead of client-computed terms", async () => {
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 402,
        data: { error: "Add credits before activating Dedicated." },
      });
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(3));
    expect(apiWithStatus).toHaveBeenLastCalledWith(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`,
      {
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: { Authorization: "Bearer cloud-token" },
        json: {
          action: "activate_dedicated",
          quoteId: QUOTE.quoteId,
        },
      },
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Add credits before activating Dedicated.",
    );
  });

  it.each(["unmount", "pagehide", "session change"] as const)(
    "cancels the already running handoff on %s with the same activation signal",
    async (change) => {
      apiWithStatus.mockImplementation(async (_url, init) => ({
        status: 200,
        data: {
          data:
            init.method === "POST"
              ? { dedicatedAgentId: "00000000-0000-4000-8000-000000000099" }
              : QUOTE,
        },
      }));
      let finish!: (value: unknown) => void;
      runSharedToDedicatedUpgradeHandoff.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = renderChangingAgent();
      await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
      await userEvent.click(
        await screen.findByRole("button", { name: "Activate Dedicated" }),
      );
      await waitFor(() =>
        expect(runSharedToDedicatedUpgradeHandoff).toHaveBeenCalledTimes(1),
      );
      const signal = runSharedToDedicatedUpgradeHandoff.mock.calls[0][0]
        .signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      const post = apiWithStatus.mock.calls.find(
        ([, init]) => init.method === "POST",
      );
      expect(post?.[1].signal).toBe(signal);
      act(() => {
        if (change === "unmount") view.unmount();
        else if (change === "session change")
          dispatchStewardSessionChange("cleared");
        else
          window.dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          );
      });
      expect(signal.aborted).toBe(true);
      await act(async () => {
        finish({ status: "failed", imported: 0, sourceCleanup: "unchanged" });
      });
      expect(silentlyRepointToDedicated).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalledWith(
        expect.stringContaining("Upgrade complete"),
      );
    },
  );

  it("repoints the active live chat and announces the switch before navigating", async () => {
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000099";
    const dedicatedApiBase = `http://127.0.0.1:18787/api/v1/eliza/agents/${dedicatedAgentId}/api`;
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { dedicatedAgentId } },
      });
    client.getBaseUrl.mockReturnValue(
      `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`,
    );
    directCloudSharedAgentIdFromBase.mockReturnValue(PERSONAL_ID);
    runSharedToDedicatedUpgradeHandoff.mockImplementationOnce(
      async (params) => {
        await params.onSwitch(dedicatedApiBase);
        return {
          status: "switched-empty",
          imported: 0,
          sourceCleanup: "preserved-rowless",
        };
      },
    );
    const phases: Array<Record<string, unknown>> = [];
    const onPhase = (event: Event) =>
      phases.push((event as CustomEvent).detail as Record<string, unknown>);
    window.addEventListener("eliza:cloud-handoff-phase", onPhase);
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() =>
      expect(silentlyRepointToDedicated).toHaveBeenCalledWith({
        containerBase: dedicatedApiBase,
        authToken: "cloud-token",
        dedicatedAgentId,
        personalElizaId: PERSONAL_ID,
      }),
    );
    expect(phases).toContainEqual({
      agentId: PERSONAL_ID,
      phase: "switched-empty",
      imported: 0,
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Upgrade complete — your conversation moved to the dedicated agent.",
    );
    window.removeEventListener("eliza:cloud-handoff-phase", onPhase);
  });

  it("does not hijack an unrelated active chat after a management upgrade", async () => {
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000099";
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { dedicatedAgentId } },
      });
    client.getBaseUrl.mockReturnValue("https://another-agent.example.test");
    directCloudSharedAgentIdFromBase.mockReturnValue("another-agent");
    runSharedToDedicatedUpgradeHandoff.mockImplementationOnce(
      async (params) => {
        await params.onSwitch("https://dedicated-agent.example.test");
        return {
          status: "switched-empty",
          imported: 0,
          sourceCleanup: "preserved-rowless",
        };
      },
    );
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() =>
      expect(runSharedToDedicatedUpgradeHandoff).toHaveBeenCalledTimes(1),
    );
    expect(silentlyRepointToDedicated).not.toHaveBeenCalled();
  });

  it("shows a credit action instead of an activation button when the server denies the quote", async () => {
    apiWithStatus.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          ...QUOTE,
          balanceUsd: 0,
          deficitUsd: 0.72,
          canActivate: false,
          unavailableReason: "Add credits to activate Dedicated.",
        },
      },
    });
    renderActions();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add funds to upgrade" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Add credits to activate Dedicated.",
    );
    expect(
      screen.getByRole("button", { name: "Add funds to upgrade" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Add funds to upgrade" }),
    );
    expect(screen.getByText("Billing destination")).toBeTruthy();
  });
});
