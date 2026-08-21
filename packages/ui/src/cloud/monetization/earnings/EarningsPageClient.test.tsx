/**
 * Exercises the earnings redemption dialog against the canonical HTTP
 * contract while network, notification, and translation boundaries are mocked.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("../../lib/api-client", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) => {
      const template = options?.defaultValue ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options?.[name] ?? `{{${name}}}`),
      );
    },
}));

import { EarningsPageClient } from "./EarningsPageClient";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE_ADDRESS = "0x0000000000000000000000000000000000000002";

const balancePayload = {
  balance: {
    totalEarned: 500,
    availableBalance: 100,
    pendingBalance: 0,
    totalRedeemed: 400,
    totalPending: 0,
    totalConvertedToCredits: 0,
  },
  bySource: [],
  recentEarnings: [],
  limits: {
    minRedemptionUsd: 1,
    maxSingleRedemptionUsd: 1_000,
    userDailyLimitUsd: 2_000,
    userHourlyLimitUsd: 1_000,
  },
  eligibility: {
    canRedeem: true,
    dailyLimitRemaining: 2_000,
    reason: undefined as string | undefined,
  },
};

const statusPayload = {
  success: true as const,
  operational: true,
  canRedeem: true,
  message: "Redemptions are operational.",
  availableNetworks: ["base", "solana", "ethereum", "bnb"] as const,
  unavailableNetworks: [] as const,
  wallets: {
    evm: { configured: true, address: BASE_ADDRESS },
    solana: { configured: true, address: "11111111111111111111111111111111" },
  },
  networks: (["base", "solana", "ethereum", "bnb"] as const).map((network) => ({
    network,
    available: true,
    status: "operational",
    balance: 10_000,
    balanceAvailable: true,
  })),
  warnings: [],
  lastChecked: "2026-08-20T12:00:00.000Z",
};

function quotePayload({
  pointsAmount = 1_234,
  network = "base",
  canRedeem = true,
  validUntil = new Date(Date.now() + 60_000).toISOString(),
}: {
  pointsAmount?: number;
  network?: "base" | "solana" | "ethereum" | "bnb";
  canRedeem?: boolean;
  validUntil?: string;
} = {}) {
  return {
    success: true as const,
    quote: {
      asset: "eliza" as const,
      network,
      tokenAddress: "0x0000000000000000000000000000000000000001",
      pointsAmount,
      usdValue: pointsAmount / 100,
      twapPriceUsd: 0.25,
      spotPriceUsd: 0.26,
      priceMethod: "TWAP" as const,
      elizaAmount: pointsAmount / 25,
      safetySpreadPercent: 5,
      sampleCount: 12,
      volatilityPercent: "1.20",
      tokensAvailable: canRedeem,
      hotWalletBalance: canRedeem ? 10_000 : 0,
      validUntil,
      validitySeconds: 60,
      requiresDelay: false,
      requiresAdminApproval: false,
      limits: {
        minRedemptionUsd: 1,
        maxRedemptionUsd: 1_000,
        userDailyLimitUsd: 2_000,
        userHourlyLimitUsd: 1_000,
        largeRedemptionThresholdUsd: 1_000,
        adminApprovalThresholdUsd: 10_000,
      },
    },
    message: canRedeem
      ? "Quote ready"
      : "Insufficient hot-wallet liquidity on Base.",
    canRedeem,
  };
}

type QuoteFactory = (input: {
  pointsAmount: number;
  network: "base" | "solana" | "ethereum" | "bnb";
}) =>
  | ReturnType<typeof quotePayload>
  | Promise<ReturnType<typeof quotePayload>>;

function installApiResponses({
  balance = balancePayload,
  quoteFactory = ({ pointsAmount, network }) =>
    quotePayload({ pointsAmount, network }),
  redemptions = [],
  submit = async () => ({
    success: true as const,
    redemptionId: "redemption-1",
    message: "Redemption created and will be processed shortly.",
  }),
}: {
  balance?: typeof balancePayload;
  quoteFactory?: QuoteFactory;
  redemptions?: Array<Record<string, unknown>>;
  submit?: (request: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  apiMock.mockImplementation(
    async (
      path: string,
      init?: { method?: string; json?: Record<string, unknown> },
    ) => {
      if (path === "/api/v1/redemptions/balance") return balance;
      if (path === "/api/v1/redemptions?limit=10") {
        return { success: true, redemptions, paused: false };
      }
      if (path === "/api/v1/redemptions/status") return statusPayload;
      if (path.startsWith("/api/v1/redemptions/quote?")) {
        const url = new URL(path, "http://test.local");
        const network = (url.searchParams.get("network") ?? "base") as
          | "base"
          | "solana"
          | "ethereum"
          | "bnb";
        return quoteFactory({
          pointsAmount: Number(url.searchParams.get("pointsAmount")),
          network,
        });
      }
      if (path === "/api/v1/redemptions" && init?.method === "POST") {
        return submit(init.json ?? {});
      }
      throw new Error(`Unexpected API call: ${path}`);
    },
  );
}

function quoteCalls() {
  return apiMock.mock.calls.filter(
    ([path]) =>
      typeof path === "string" && path.startsWith("/api/v1/redemptions/quote?"),
  );
}

function postCalls() {
  return apiMock.mock.calls.filter(
    ([path, init]) => path === "/api/v1/redemptions" && init?.method === "POST",
  );
}

async function openRedemptionDialog() {
  const user = userEvent.setup();
  render(<EarningsPageClient />);
  await user.click(
    await screen.findByRole("button", { name: "Redeem for elizaOS" }),
  );
  await screen.findByRole("dialog", { name: "Redeem for elizaOS Tokens" });
  return user;
}

async function fillBaseIntent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Amount to Redeem (USD)"), "12.34");
  await user.type(
    screen.getByPlaceholderText("Enter 0x address"),
    BASE_ADDRESS,
  );
  await screen.findByText("49.3600 elizaOS");
}

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
  });
  apiMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  let uuidSequence = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    uuidSequence += 1;
    return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
  });
  installApiResponses();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EarningsPageClient redemption contract", () => {
  it("renders canonical camelCase history with the server asset label", async () => {
    apiMock.mockReset();
    installApiResponses({
      redemptions: [
        {
          id: "history-1",
          pointsAmount: 500,
          usdValue: 5,
          elizaAmount: 5,
          elizaPriceUsd: 1,
          asset: "usdc",
          network: "base",
          payoutAddress: "0x000...0002",
          status: "completed",
          txHash: "0xhistory",
          createdAt: "2026-08-20T12:00:00.000Z",
          completedAt: "2026-08-20T12:01:00.000Z",
          failureReason: null,
          requiresReview: false,
        },
      ],
    });

    render(<EarningsPageClient />);

    expect(await screen.findByText("$5.00")).toBeTruthy();
    expect(screen.getByText("5.00 USDC")).toBeTruthy();
    expect(screen.getByText("Across all payout assets")).toBeTruthy();
    expect(screen.queryByText("Converted to elizaOS tokens")).toBeNull();
    expect(screen.queryByText(/Invalid Date|NaN/)).toBeNull();
    expect(
      screen.getByRole("link", { name: "View" }).getAttribute("href"),
    ).toBe("https://basescan.org/tx/0xhistory");
  });

  it("quotes and submits pointsAmount, asset, and an intent UUID", async () => {
    const user = await openRedemptionDialog();
    await fillBaseIntent(user);

    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/redemptions/quote?pointsAmount=1234&network=base",
    );
    expect(screen.getByText("$0.250000/token")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Redeem Tokens" }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const request = postCalls()[0]?.[1]?.json;
    expect(request).toMatchObject({
      pointsAmount: 1_234,
      network: "base",
      asset: "eliza",
      payoutAddress: BASE_ADDRESS,
    });
    expect(request?.idempotencyKey).toMatch(UUID_PATTERN);
    expect(toastMock.success).toHaveBeenCalledWith(
      "Redemption request submitted!",
      {
        description: "Redemption created and will be processed shortly.",
      },
    );
  });

  it("shows the provider reason and blocks an unavailable quote", async () => {
    apiMock.mockReset();
    installApiResponses({
      quoteFactory: ({ pointsAmount, network }) =>
        quotePayload({ pointsAmount, network, canRedeem: false }),
    });
    const user = await openRedemptionDialog();
    await user.type(screen.getByLabelText("Amount to Redeem (USD)"), "12.34");
    await user.type(
      screen.getByPlaceholderText("Enter 0x address"),
      BASE_ADDRESS,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Insufficient hot-wallet liquidity on Base.",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Redeem Tokens" })
        .disabled,
    ).toBe(true);
    expect(postCalls()).toHaveLength(0);
  });

  it("rejects non-canonical precision without requesting a quote", async () => {
    await openRedemptionDialog();
    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: "1.001" },
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Enter a valid USD amount with at most two decimal places.",
    );
    expect(quoteCalls()).toHaveLength(0);
  });

  it.each([
    ["0.99", "Minimum redemption is $1.00."],
    ["100.01", "Maximum available redemption is $100.00."],
  ])("enforces the effective UI bound for %s", async (amount, message) => {
    await openRedemptionDialog();
    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: amount },
    });

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(quoteCalls()).toHaveLength(0);
  });

  it("caps at a fractional daily remainder without losing a cent", async () => {
    apiMock.mockReset();
    installApiResponses({
      balance: {
        ...balancePayload,
        balance: { ...balancePayload.balance, availableBalance: 1.15 },
        eligibility: {
          ...balancePayload.eligibility,
          dailyLimitRemaining: 1.15,
        },
      },
    });
    await openRedemptionDialog();
    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: "1.15" },
    });
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/redemptions/quote?pointsAmount=115&network=base",
      ),
    );

    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: "1.16" },
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Maximum available redemption is $1.15.",
    );
  });

  it("surfaces server ineligibility when the daily remainder is below minimum", async () => {
    apiMock.mockReset();
    installApiResponses({
      balance: {
        ...balancePayload,
        eligibility: {
          canRedeem: false,
          dailyLimitRemaining: 0.5,
          reason:
            "Daily limit remaining ($0.50) is below the $1.00 minimum redemption.",
        },
      },
    });
    render(<EarningsPageClient />);

    const redeem = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Redeem for elizaOS",
    });
    expect(redeem.disabled).toBe(true);
    expect(
      screen.getByText(
        "Daily limit remaining ($0.50) is below the $1.00 minimum redemption.",
      ),
    ).toBeTruthy();
  });

  it("invalidates a stale amount quote before the replacement debounce", async () => {
    const user = await openRedemptionDialog();
    await fillBaseIntent(user);
    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: "12.35" },
    });

    expect(screen.queryByText("49.3600 elizaOS")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Redeem Tokens" })
        .disabled,
    ).toBe(true);
    expect(quoteCalls()).toHaveLength(1);
  });

  it("clears the quote spinner when an in-flight intent becomes invalid", async () => {
    let resolveQuote:
      | ((value: ReturnType<typeof quotePayload>) => void)
      | undefined;
    const pendingQuote = new Promise<ReturnType<typeof quotePayload>>(
      (resolve) => {
        resolveQuote = resolve;
      },
    );
    apiMock.mockReset();
    installApiResponses({ quoteFactory: async () => pendingQuote });
    await openRedemptionDialog();
    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: "12.34" },
    });
    await screen.findByText("Getting quote...");

    fireEvent.change(screen.getByLabelText("Amount to Redeem (USD)"), {
      target: { value: "1.001" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Getting quote...")).toBeNull(),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Enter a valid USD amount with at most two decimal places.",
    );

    resolveQuote?.(quotePayload());
    await waitFor(() =>
      expect(screen.queryByText("49.3600 elizaOS")).toBeNull(),
    );
  });

  it("invalidates a stale network quote before requesting the new network", async () => {
    const user = await openRedemptionDialog();
    await fillBaseIntent(user);
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Solana/ }));

    expect(screen.queryByText("49.3600 elizaOS")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Redeem Tokens" })
        .disabled,
    ).toBe(true);
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/redemptions/quote?pointsAmount=1234&network=solana",
      );
    });
  });

  it("marks an elapsed quote expired and refreshes the same intent", async () => {
    apiMock.mockReset();
    installApiResponses({
      quoteFactory: ({ pointsAmount, network }) =>
        quotePayload({
          pointsAmount,
          network,
          validUntil: new Date(Date.now() + 60).toISOString(),
        }),
    });
    const user = await openRedemptionDialog();
    await fillBaseIntent(user);

    const refresh = await screen.findByRole("button", {
      name: "Refresh quote",
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Redeem Tokens" })
        .disabled,
    ).toBe(true);
    await user.click(refresh);
    await waitFor(() => expect(quoteCalls()).toHaveLength(2), {
      timeout: 1_500,
    });
    expect(quoteCalls()[1]?.[0]).toBe(
      "/api/v1/redemptions/quote?pointsAmount=1234&network=base",
    );
  });

  it("reuses the same idempotency key when a submission is retried", async () => {
    let attempts = 0;
    apiMock.mockReset();
    installApiResponses({
      submit: async () => {
        attempts += 1;
        return attempts === 1
          ? { success: false as const, error: "Processor busy" }
          : {
              success: true as const,
              redemptionId: "redemption-1",
              message: "Created",
            };
      },
    });
    const user = await openRedemptionDialog();
    await fillBaseIntent(user);
    const submit = screen.getByRole("button", { name: "Redeem Tokens" });

    await user.click(submit);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Redemption failed", {
        description: "Processor busy",
      }),
    );
    await user.click(submit);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));

    expect(postCalls()).toHaveLength(2);
    const firstKey = postCalls()[0]?.[1]?.json?.idempotencyKey;
    const secondKey = postCalls()[1]?.[1]?.json?.idempotencyKey;
    expect(firstKey).toMatch(UUID_PATTERN);
    expect(secondKey).toBe(firstKey);
  });

  it("guards a double click with one in-flight POST", async () => {
    let resolveSubmit: ((value: unknown) => void) | undefined;
    const pendingSubmit = new Promise((resolve) => {
      resolveSubmit = resolve;
    });
    apiMock.mockReset();
    installApiResponses({ submit: async () => pendingSubmit });
    const user = await openRedemptionDialog();
    await fillBaseIntent(user);
    const submit = screen.getByRole("button", { name: "Redeem Tokens" });

    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(postCalls()).toHaveLength(1);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" })
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Redeem for elizaOS Tokens" }),
    ).toBeTruthy();

    resolveSubmit?.({
      success: true,
      redemptionId: "redemption-1",
      message: "Created",
    });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Redeem for elizaOS Tokens" }),
      ).toBeNull(),
    );
  });
});
