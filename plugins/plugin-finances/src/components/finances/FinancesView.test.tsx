// @vitest-environment jsdom
//
// Renders the real FinancesView component (the gui `finances` view) against
// realistic FinancesViewProps and asserts the populated DATA of all three
// sections — balance summary, transactions, recurring charges — with exact
// formatted values, plus every empty state. The view is purely props-driven
// and stateless (no buttons / inputs / fetch / hooks), so there are no
// interactive controls to drive; coverage is data-render correctness.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinanceBalanceSummaryDTO,
  FinancesViewProps,
  FinanceTransactionDTO,
  RecurringChargeDTO,
} from "../../types.ts";
import { FinancesView } from "./FinancesView.tsx";

const balance: FinanceBalanceSummaryDTO = {
  netBalanceMinor: 1234567, // -> $12,345.67
  currency: "USD",
  monthlyIncomeMinor: 500000, // -> $5,000.00
  monthlyOutflowMinor: 320000, // -> $3,200.00
  asOf: "2026-06-01",
};

const transactions: FinanceTransactionDTO[] = [
  {
    id: "tx-1",
    occurredAt: "2026-06-10",
    amountMinor: 250000, // -> $2,500.00 (inflow, posted)
    currency: "USD",
    description: "Payroll deposit",
    category: "income",
    merchant: "Acme Corp",
    status: "posted",
    source: "bank",
  },
  {
    id: "tx-2",
    occurredAt: "2026-06-11",
    amountMinor: -4599, // -> -$45.99 (outflow, pending)
    currency: "USD",
    description: "Coffee subscription",
    category: "food",
    merchant: "Blue Bottle",
    status: "pending",
    source: "card",
  },
  {
    id: "tx-3",
    occurredAt: "2026-06-12",
    amountMinor: -129900, // -> -$1,299.00 (outflow, posted)
    currency: "USD",
    description: "Laptop purchase",
    category: "equipment",
    merchant: "Apple",
    status: "posted",
    source: "card",
  },
];

const recurring: RecurringChargeDTO[] = [
  {
    id: "rec-1",
    label: "Netflix",
    amountMinor: 1599, // -> $15.99
    currency: "USD",
    cadence: "monthly",
    nextChargeAt: "2026-07-01",
    merchant: "Netflix",
    active: true,
  },
  {
    id: "rec-2",
    label: "Domain renewal",
    amountMinor: 1200, // -> $12.00
    currency: "USD",
    cadence: "yearly",
    nextChargeAt: null, // -> "—" fallback
    merchant: "Namecheap",
    active: false,
  },
];

const fullProps: FinancesViewProps = { balance, transactions, recurring };

afterEach(cleanup);

describe("FinancesView — balance summary section", () => {
  it("renders the heading and the 4 labeled fields with exact formatted values", () => {
    render(<FinancesView {...fullProps} />);

    expect(screen.getByRole("heading", { name: "Balance" })).toBeTruthy();

    // The four <dt> labels.
    expect(screen.getByText("Net balance")).toBeTruthy();
    expect(screen.getByText("This month — in")).toBeTruthy();
    expect(screen.getByText("This month — out")).toBeTruthy();
    expect(screen.getByText("As of")).toBeTruthy();

    // Their formatted <dd> values (minor units -> major currency).
    expect(screen.getByText("$12,345.67")).toBeTruthy();
    expect(screen.getByText("$5,000.00")).toBeTruthy();
    expect(screen.getByText("$3,200.00")).toBeTruthy();
    expect(screen.getByText("2026-06-01")).toBeTruthy();
  });

  it("renders 'No balance data yet.' when balance is undefined", () => {
    render(<FinancesView transactions={transactions} recurring={recurring} />);
    expect(screen.getByText("No balance data yet.")).toBeTruthy();
    // The heading is still present even with no data.
    expect(screen.getByRole("heading", { name: "Balance" })).toBeTruthy();
  });
});

describe("FinancesView — transactions section", () => {
  it("renders every transaction row in order with date, description, amount, status", () => {
    const { container } = render(<FinancesView {...fullProps} />);

    expect(screen.getByRole("heading", { name: "Transactions" })).toBeTruthy();

    const list = container.querySelector(".finances-transactions-list");
    expect(list).toBeTruthy();
    const rows = list?.querySelectorAll(".finances-transactions-row");
    expect(rows?.length).toBe(3);

    // Descriptions render.
    expect(screen.getByText("Payroll deposit")).toBeTruthy();
    expect(screen.getByText("Coffee subscription")).toBeTruthy();
    expect(screen.getByText("Laptop purchase")).toBeTruthy();

    // Dates render.
    expect(screen.getByText("2026-06-10")).toBeTruthy();
    expect(screen.getByText("2026-06-11")).toBeTruthy();
    expect(screen.getByText("2026-06-12")).toBeTruthy();

    // Formatted amounts (incl. negative outflows).
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("-$45.99")).toBeTruthy();
    expect(screen.getByText("-$1,299.00")).toBeTruthy();

    // Status labels: 2x posted, 1x pending.
    expect(screen.getAllByText("posted")).toHaveLength(2);
    expect(screen.getByText("pending")).toBeTruthy();

    // First row is the payroll deposit (order preserved from props).
    const firstRow = rows?.[0] as HTMLElement;
    expect(within(firstRow).getByText("Payroll deposit")).toBeTruthy();
    expect(within(firstRow).getByText("2026-06-10")).toBeTruthy();
    expect(within(firstRow).getByText("$2,500.00")).toBeTruthy();
    expect(within(firstRow).getByText("posted")).toBeTruthy();
  });

  it("renders 'No transactions yet.' when transactions is undefined", () => {
    render(<FinancesView balance={balance} recurring={recurring} />);
    expect(screen.getByText("No transactions yet.")).toBeTruthy();
  });

  it("renders 'No transactions yet.' when transactions is an empty array", () => {
    render(
      <FinancesView
        balance={balance}
        transactions={[]}
        recurring={recurring}
      />,
    );
    expect(screen.getByText("No transactions yet.")).toBeTruthy();
  });
});

describe("FinancesView — recurring charges section", () => {
  it("renders every recurring row with label, cadence, amount and nextChargeAt fallback", () => {
    const { container } = render(<FinancesView {...fullProps} />);

    expect(
      screen.getByRole("heading", { name: "Recurring charges" }),
    ).toBeTruthy();

    const list = container.querySelector(".finances-recurring-list");
    expect(list).toBeTruthy();
    const rows = list?.querySelectorAll(".finances-recurring-row");
    expect(rows?.length).toBe(2);

    // Labels.
    expect(screen.getByText("Netflix")).toBeTruthy();
    expect(screen.getByText("Domain renewal")).toBeTruthy();

    // Cadences.
    expect(screen.getByText("monthly")).toBeTruthy();
    expect(screen.getByText("yearly")).toBeTruthy();

    // Formatted amounts.
    expect(screen.getByText("$15.99")).toBeTruthy();
    expect(screen.getByText("$12.00")).toBeTruthy();

    // nextChargeAt: dated row shows its date.
    const netflixRow = rows?.[0] as HTMLElement;
    expect(within(netflixRow).getByText("2026-07-01")).toBeTruthy();

    // nextChargeAt: null row shows the "—" fallback.
    const domainRow = rows?.[1] as HTMLElement;
    expect(within(domainRow).getByText("—")).toBeTruthy();
  });

  it("renders 'No recurring charges tracked.' when recurring is undefined", () => {
    render(<FinancesView balance={balance} transactions={transactions} />);
    expect(screen.getByText("No recurring charges tracked.")).toBeTruthy();
  });

  it("renders 'No recurring charges tracked.' when recurring is an empty array", () => {
    render(
      <FinancesView
        balance={balance}
        transactions={transactions}
        recurring={[]}
      />,
    );
    expect(screen.getByText("No recurring charges tracked.")).toBeTruthy();
  });
});

describe("FinancesView — combined / partial props", () => {
  it("renders all three empty states when called with no props", () => {
    render(<FinancesView />);
    expect(screen.getByText("No balance data yet.")).toBeTruthy();
    expect(screen.getByText("No transactions yet.")).toBeTruthy();
    expect(screen.getByText("No recurring charges tracked.")).toBeTruthy();

    // All three section headings still render in the empty case.
    expect(screen.getByRole("heading", { name: "Balance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Transactions" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Recurring charges" }),
    ).toBeTruthy();
  });

  it("renders sections independently: populated balance with empty lists", () => {
    render(<FinancesView balance={balance} transactions={[]} recurring={[]} />);

    // Balance is populated...
    expect(screen.getByText("$12,345.67")).toBeTruthy();
    expect(screen.queryByText("No balance data yet.")).toBeNull();

    // ...while the two lists fall to their empty states.
    expect(screen.getByText("No transactions yet.")).toBeTruthy();
    expect(screen.getByText("No recurring charges tracked.")).toBeTruthy();
  });
});
