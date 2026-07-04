/**
 * Renders the presentational owner-finance dashboard through both output paths
 * — DOM static markup and real terminal lines via `registerSpatialTerminalView`
 * — asserting the one spatial tree behaves across GUI/XR and TUI. Deterministic
 * fixtures, no live model or DB.
 */

import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FINANCES_SNAPSHOT,
  type FinanceRecurringCard,
  type FinancesSnapshot,
  FinancesSpatialView,
  type FinanceTransactionCard,
} from "./FinancesSpatialView.tsx";

function txn(
  overrides: Partial<FinanceTransactionCard> & { id: string },
): FinanceTransactionCard {
  return {
    description: `Txn ${overrides.id}`,
    meta: "Jun 16",
    amount: "-$42.50",
    outflow: true,
    ...overrides,
  };
}

function bill(
  overrides: Partial<FinanceRecurringCard> & { id: string },
): FinanceRecurringCard {
  return {
    label: `Bill ${overrides.id}`,
    meta: "monthly",
    amount: "$15.99",
    ...overrides,
  };
}

const snapshot: FinancesSnapshot = {
  state: "ready",
  note: "1 bill due this week.",
  balance: {
    net: "$2,765.50",
    negative: false,
    income: "$4,000.00",
    outflow: "$1,234.50",
    asOf: "6/17/2026",
  },
  transactions: [
    txn({ id: "t1", description: "Coffee Bar", meta: "Jun 16 • dining" }),
    txn({
      id: "t2",
      description: "Paycheck",
      amount: "$3,000.00",
      outflow: false,
    }),
  ],
  recurring: [
    bill({ id: "netflix", label: "Netflix", meta: "monthly • next Jul 1" }),
  ],
};

const view = <FinancesSpatialView snapshot={snapshot} />;

describe("FinancesSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Balance");
      expect(flat).toContain("Transactions");
      expect(flat).toContain("Recurring");
      expect(flat).toContain("Coffee Bar");
      expect(flat).toContain("Netflix");
      expect(flat).toContain("$2,765.50");
      expect(flat).toContain("bill due this week");
    }
  });

  it("GUI + XR: renders DOM with the surface marker and content, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Coffee Bar");
      expect(html).toContain("Netflix");
      expect(html).toContain("$2,765.50");
      expect(html).toContain('data-agent-id="txn-t1"');
      expect(html).toContain('data-agent-id="bill-netflix"');
    }
  });

  it("loading state renders a quiet loading line", () => {
    const lines = renderViewToLines(
      <FinancesSpatialView snapshot={EMPTY_FINANCES_SNAPSHOT} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    expect(lines.join("\n")).toContain("Loading");
  });

  it("empty state renders the connect-a-source affordance", () => {
    const empty: FinancesSnapshot = {
      ...EMPTY_FINANCES_SNAPSHOT,
      state: "empty",
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <FinancesSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(html).toContain("None");
    expect(html).toContain('data-agent-id="connect"');
  });

  it("error state renders the message and a Retry control", () => {
    const error: FinancesSnapshot = {
      ...EMPTY_FINANCES_SNAPSHOT,
      state: "error",
      error: "boom",
    };
    const lines = renderViewToLines(
      <FinancesSpatialView snapshot={error} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("boom");
    expect(flat).toContain("Retry");

    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <FinancesSpatialView snapshot={error} />
      </SpatialSurface>,
    );
    expect(html).toContain('data-agent-id="retry"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("finances-test", () => view);
    try {
      const component = getTerminalView("finances-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Coffee Bar");
    } finally {
      unregister();
    }
  });
});
