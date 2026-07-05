import { beforeEach, describe, expect, mock, test } from "bun:test";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ORG_ID = "00000000-0000-0000-0000-000000000002";

type BudgetRow = {
  id: string;
  agent_id: string;
  owner_org_id: string;
  allocated_budget: unknown;
  spent_budget: unknown;
  daily_limit: unknown;
  daily_spent: unknown;
  daily_reset_at: Date | null;
  auto_refill_enabled: boolean;
  auto_refill_amount: unknown;
  auto_refill_threshold: unknown;
  last_refill_at: Date | null;
  is_paused: boolean;
  pause_on_depleted: boolean;
  pause_reason: string | null;
  low_budget_threshold: unknown;
  low_budget_alert_sent: boolean;
};

let readBudget: BudgetRow | null = null;
let lockedBudget: BudgetRow | null = null;
let txUpdateValues: Record<string, unknown>[] = [];
let txInsertValues: Record<string, unknown>[] = [];
let dbUpdateValues: Record<string, unknown>[] = [];

const reconcileMock = mock(async () => undefined);
const reserveMock = mock(async () => ({
  reconcile: reconcileMock,
}));

const loggerMock = {
  debug: mock(() => undefined),
  error: mock(() => undefined),
  info: mock(() => undefined),
  warn: mock(() => undefined),
};

const tx = {
  select: mock(() => ({
    from: () => ({
      where: () => ({
        for: async () => (lockedBudget ? [lockedBudget] : []),
      }),
    }),
  })),
  update: mock(() => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        txUpdateValues.push(values);
      },
    }),
  })),
  insert: mock(() => ({
    values: (values: Record<string, unknown>) => {
      txInsertValues.push(values);
      return {
        returning: async () => [{ id: "txn-1" }],
      };
    },
  })),
};

const dbWriteMock = {
  transaction: mock(async (handler: (transaction: typeof tx) => Promise<unknown>) => handler(tx)),
  update: mock(() => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        dbUpdateValues.push(values);
      },
    }),
  })),
  insert: mock(() => ({
    values: () => ({
      returning: async () => [baseBudget()],
    }),
  })),
};

const dbReadMock = {
  query: {
    agentBudgetTransactions: {
      findMany: mock(async () => []),
    },
    agentBudgets: {
      findMany: mock(async () => (readBudget ? [readBudget] : [])),
    },
    userCharacters: {
      findFirst: mock(async () => ({ id: AGENT_ID, organization_id: ORG_ID })),
    },
  },
  select: mock(() => ({
    from: () => ({
      where: async () => (readBudget ? [readBudget] : []),
    }),
  })),
};

mock.module("../../db/client", () => ({
  dbRead: dbReadMock,
  dbWrite: dbWriteMock,
}));

mock.module("../utils/logger", () => ({
  logger: loggerMock,
}));

mock.module("./credits", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  creditsService: {
    reserve: reserveMock,
  },
}));

mock.module("./email", () => ({
  emailService: {
    sendLowCreditsEmail: mock(async () => undefined),
  },
}));

const { agentBudgetService } = await import("./agent-budgets");

function baseBudget(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: "budget-1",
    agent_id: AGENT_ID,
    owner_org_id: ORG_ID,
    allocated_budget: "10.0000",
    spent_budget: "1.0000",
    daily_limit: null,
    daily_spent: "0.0000",
    daily_reset_at: null,
    auto_refill_enabled: false,
    auto_refill_amount: null,
    auto_refill_threshold: null,
    last_refill_at: null,
    is_paused: false,
    pause_on_depleted: true,
    pause_reason: null,
    low_budget_threshold: null,
    low_budget_alert_sent: true,
    ...overrides,
  };
}

beforeEach(() => {
  readBudget = baseBudget();
  lockedBudget = readBudget;
  txUpdateValues = [];
  txInsertValues = [];
  dbUpdateValues = [];
  reconcileMock.mockClear();
  reserveMock.mockClear();
  loggerMock.debug.mockClear();
  loggerMock.error.mockClear();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  dbWriteMock.transaction.mockClear();
  dbWriteMock.update.mockClear();
  dbReadMock.select.mockClear();
  dbReadMock.query.userCharacters.findFirst.mockClear();
  tx.select.mockClear();
  tx.update.mockClear();
  tx.insert.mockClear();
});

describe("agentBudgetService numeric DB parsing", () => {
  test("checkBudget rejects null required DB money values instead of treating them as zero", async () => {
    readBudget = baseBudget({ allocated_budget: null });

    const result = await agentBudgetService.checkBudget(AGENT_ID, 0.25);

    expect(result).toEqual({
      canProceed: false,
      availableBudget: 0,
      dailyRemaining: null,
      isPaused: false,
      reason: "Invalid budget data",
    });
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid budget numeric value",
      expect.objectContaining({ agentId: AGENT_ID, field: "allocated_budget", value: null }),
    );
  });

  test("checkBudget accepts numeric strings and numbers, including an explicit zero daily limit", async () => {
    readBudget = baseBudget({
      allocated_budget: "12.5000",
      spent_budget: 2.25,
      daily_limit: "0.0000",
      daily_spent: 0,
    });

    const result = await agentBudgetService.checkBudget(AGENT_ID, 0.01);

    expect(result.canProceed).toBe(false);
    expect(result.availableBudget).toBe(10.25);
    expect(result.dailyRemaining).toBe(0);
    expect(result.reason).toBe("Daily limit reached. Remaining today: $0.0000");
  });

  test("checkBudget computes daily remaining from reset state after expired daily reset", async () => {
    readBudget = baseBudget({
      allocated_budget: "12.5000",
      spent_budget: "2.2500",
      daily_limit: "5.0000",
      daily_spent: "9.0000",
      daily_reset_at: new Date("2026-07-03T00:00:00.000Z"),
    });

    const result = await agentBudgetService.checkBudget(AGENT_ID, 0.25);

    expect(result).toEqual({
      canProceed: true,
      availableBudget: 10.25,
      dailyRemaining: 5,
      isPaused: false,
    });
    expect(dbUpdateValues).toHaveLength(1);
    expect(dbUpdateValues[0]).toEqual(
      expect.objectContaining({
        daily_spent: "0.0000",
        daily_reset_at: expect.any(Date),
        updated_at: expect.any(Date),
      }),
    );
  });

  test("checkBudget rejects invalid optional DB daily limits instead of ignoring them", async () => {
    readBudget = baseBudget({ daily_limit: "not-money" });

    const result = await agentBudgetService.checkBudget(AGENT_ID, 0.25);

    expect(result.canProceed).toBe(false);
    expect(result.reason).toBe("Invalid budget data");
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid budget numeric value",
      expect.objectContaining({ agentId: AGENT_ID, field: "daily_limit", value: "not-money" }),
    );
  });

  test("deductBudget rejects empty required DB money values before mutating budget state", async () => {
    lockedBudget = baseBudget({ spent_budget: "" });

    const result = await agentBudgetService.deductBudget({
      agentId: AGENT_ID,
      amount: 0.5,
      description: "usage",
    });

    expect(result).toEqual({
      success: false,
      newBalance: 0,
      dailySpent: 0,
      error: "Invalid budget data",
    });
    expect(txUpdateValues).toEqual([]);
    expect(txInsertValues).toEqual([]);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid budget numeric value",
      expect.objectContaining({ agentId: AGENT_ID, field: "spent_budget", value: "" }),
    );
  });

  test("allocateBudget refunds org-credit reservations when locked budget data is invalid", async () => {
    lockedBudget = baseBudget({ allocated_budget: "not-money" });

    const result = await agentBudgetService.allocateBudget({
      agentId: AGENT_ID,
      amount: 2,
      fromOrgCredits: true,
      description: "manual allocation",
    });

    expect(result).toEqual({
      success: false,
      newBalance: 0,
      error: "Invalid budget data",
    });
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        amount: 2,
      }),
    );
    expect(reconcileMock).toHaveBeenCalledWith(0);
    expect(txUpdateValues).toEqual([]);
    expect(txInsertValues).toEqual([]);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid budget numeric value",
      expect.objectContaining({
        agentId: AGENT_ID,
        field: "allocated_budget",
        value: "not-money",
      }),
    );
  });

  test("deductBudget accepts valid numeric strings and numbers and persists formatted budget values", async () => {
    lockedBudget = baseBudget({
      allocated_budget: 10,
      spent_budget: "1.2500",
      daily_limit: "5.0000",
      daily_spent: 1,
    });

    const result = await agentBudgetService.deductBudget({
      agentId: AGENT_ID,
      amount: 2.5,
      description: "model usage",
    });

    expect(result).toEqual({
      success: true,
      newBalance: 6.25,
      dailySpent: 3.5,
      transactionId: "txn-1",
    });
    expect(txUpdateValues[0]).toMatchObject({
      spent_budget: "3.7500",
      daily_spent: "3.5000",
    });
    expect(txInsertValues[0]).toMatchObject({
      amount: "-2.5000",
      balance_after: "6.2500",
      daily_spent_after: "3.5000",
    });
  });

  test("triggerAutoRefill rejects empty DB refill amounts without reserving credits", async () => {
    readBudget = baseBudget({
      auto_refill_enabled: true,
      auto_refill_amount: "",
    });

    const result = await agentBudgetService.triggerAutoRefill(AGENT_ID);

    expect(result).toBe(false);
    expect(reserveMock).not.toHaveBeenCalled();
    expect(dbWriteMock.transaction).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid auto-refill amount",
      expect.objectContaining({ agentId: AGENT_ID, value: "" }),
    );
  });

  test("triggerAutoRefill accepts a valid numeric refill amount and allocates it", async () => {
    readBudget = baseBudget({
      allocated_budget: "3.0000",
      spent_budget: "1.0000",
      auto_refill_enabled: true,
      auto_refill_amount: 2.5,
    });
    lockedBudget = readBudget;

    const result = await agentBudgetService.triggerAutoRefill(AGENT_ID);

    expect(result).toBe(true);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        amount: 2.5,
      }),
    );
    expect(txUpdateValues[0]).toMatchObject({ allocated_budget: "5.5000" });
    expect(dbUpdateValues[0]).toEqual(
      expect.objectContaining({
        last_refill_at: expect.any(Date),
        updated_at: expect.any(Date),
      }),
    );
  });

  test("processAutoRefills records null refill amounts as failed instead of refilling zero dollars", async () => {
    readBudget = baseBudget({
      allocated_budget: "1.0000",
      spent_budget: "0.0000",
      auto_refill_enabled: true,
      auto_refill_amount: null,
      auto_refill_threshold: "2.0000",
    });

    const result = await agentBudgetService.processAutoRefills();

    expect(result).toEqual({
      processed: 0,
      errors: 1,
      failedAgents: [AGENT_ID],
    });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid auto-refill amount",
      expect.objectContaining({ agentId: AGENT_ID, value: null }),
    );
  });

  test("updateSettings rejects non-finite numeric inputs without writing partial settings", async () => {
    const result = await agentBudgetService.updateSettings(AGENT_ID, {
      autoRefillEnabled: true,
      autoRefillAmount: Number.NaN,
    });

    expect(result).toEqual({
      success: false,
      error: "Invalid budget settings",
    });
    expect(dbUpdateValues).toEqual([]);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[AgentBudgets] Invalid budget settings numeric value",
      expect.objectContaining({
        agentId: AGENT_ID,
        field: "auto_refill_amount",
        value: Number.NaN,
      }),
    );
  });
});
