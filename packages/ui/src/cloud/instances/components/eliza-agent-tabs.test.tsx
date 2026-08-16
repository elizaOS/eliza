/** Verifies the agent detail tab strip's WAI-ARIA relationships and keyboard navigation. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./eliza-wallet-section", () => ({
  ElizaWalletSection: () => <p>Wallet content</p>,
}));
vi.mock("./eliza-transactions-section", () => ({
  ElizaTransactionsSection: () => <p>Transactions content</p>,
}));
vi.mock("./eliza-policies-section", () => ({
  ElizaPoliciesSection: () => <p>Policies content</p>,
}));

import { ElizaAgentTabs } from "./eliza-agent-tabs";

describe("ElizaAgentTabs", () => {
  afterEach(() => cleanup());

  it("links the selected tab to the active panel", () => {
    render(
      <ElizaAgentTabs agentId="agent-1">
        <p>Overview content</p>
      </ElizaAgentTabs>,
    );

    const tablist = screen.getByRole("tablist", { name: "Agents" });
    const tabs = screen.getAllByRole("tab");
    const panel = screen.getByRole("tabpanel");
    expect(tablist.contains(tabs[0] ?? null)).toBe(true);
    expect(tabs).toHaveLength(4);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    expect(screen.getByText("Overview content")).toBeTruthy();
  });

  it("selects and focuses tabs with click, arrows, Home, and End", () => {
    render(
      <ElizaAgentTabs agentId="agent-1">
        <p>Overview content</p>
      </ElizaAgentTabs>,
    );

    const overview = screen.getByRole("tab", { name: "Overview" });
    const wallet = screen.getByRole("tab", { name: "Wallet" });
    const transactions = screen.getByRole("tab", { name: "Transactions" });
    const policies = screen.getByRole("tab", { name: "Policies" });

    fireEvent.click(wallet);
    expect(wallet.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Wallet content")).toBeTruthy();

    wallet.focus();
    fireEvent.keyDown(wallet, { key: "ArrowRight" });
    expect(document.activeElement).toBe(transactions);
    expect(transactions.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Transactions content")).toBeTruthy();

    fireEvent.keyDown(transactions, { key: "End" });
    expect(document.activeElement).toBe(policies);
    expect(screen.getByText("Policies content")).toBeTruthy();

    fireEvent.keyDown(policies, { key: "Home" });
    expect(document.activeElement).toBe(overview);
    expect(screen.getByText("Overview content")).toBeTruthy();

    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(policies);
  });
});
