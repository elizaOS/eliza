// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getCloudBillingHistory: vi.fn(),
    getLifeOpsPaymentsDashboard: vi.fn(),
    markLifeOpsBillPaid: vi.fn(),
    snoozeLifeOpsBill: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
  useApp: () => ({
    elizaCloudConnected: true,
    elizaCloudCredits: 42,
    elizaCloudCreditsCritical: false,
    elizaCloudCreditsLow: false,
  }),
}));

vi.mock("./LifeOpsChatAdapter.js", () => ({
  useLifeOpsChatLauncher: () => ({
    openLifeOpsChat: vi.fn(),
  }),
}));

vi.mock("./LifeOpsLinkBankButton.js", () => ({
  LifeOpsLinkBankButton: () => <button type="button">Link bank</button>,
}));

vi.mock("./LifeOpsLinkPaypalButton.js", () => ({
  LifeOpsLinkPaypalButton: () => <button type="button">Link PayPal</button>,
}));

import { LifeOpsMoneySection } from "./LifeOpsMoneySection.js";

beforeEach(() => {
  clientMock.getLifeOpsPaymentsDashboard.mockResolvedValue({
    recurring: [],
    recurringPlaybookHits: [],
    sources: [],
    spending: {
      recurringSpendUsd: 19.99,
      topCategories: [],
      topMerchants: [],
      totalSpendUsd: 123.45,
      windowDays: 30,
    },
    upcomingBills: [],
  });
  clientMock.getCloudBillingHistory.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsMoneySection", () => {
  it("loads and renders the money dashboard route shell", async () => {
    render(<LifeOpsMoneySection />);

    await waitFor(() =>
      expect(clientMock.getLifeOpsPaymentsDashboard).toHaveBeenCalledWith({
        windowDays: 30,
      }),
    );
    expect(await screen.findByTestId("lifeops-money-section")).toBeTruthy();
    expect(screen.getByText("Last 30d spend")).toBeTruthy();
    expect(screen.getByText("$123.45")).toBeTruthy();
  });

  it("renders extracted bills that need due-date review", async () => {
    clientMock.getLifeOpsPaymentsDashboard.mockResolvedValueOnce({
      recurring: [],
      recurringPlaybookHits: [],
      sources: [],
      spending: {
        recurringSpendUsd: 0,
        topCategories: [],
        topMerchants: [],
        totalSpendUsd: 0,
        windowDays: 30,
      },
      upcomingBills: [
        {
          id: "bill-1",
          merchant: "Power Co",
          amountUsd: 91.23,
          currency: "USD",
          dueDate: null,
          status: "needs_due_date",
          postedAt: "2026-04-26T12:00:00.000Z",
          sourceMessageId: "gmail-1",
          confidence: 0.8,
        },
      ],
    });

    render(<LifeOpsMoneySection />);

    expect(await screen.findByText("Power Co")).toBeTruthy();
    expect(screen.getByText("Needs date")).toBeTruthy();
    expect(screen.getByText("Review date")).toBeTruthy();
  });
});
