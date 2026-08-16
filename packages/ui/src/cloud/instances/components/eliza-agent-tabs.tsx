"use client";

/**
 * Tab strip for the cloud agent-instance detail view (logs, wallet, policies,
 * transactions, backups).
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../../components/ui/button";
import { useT } from "../lib/i18n";
import { ElizaPoliciesSection } from "./eliza-policies-section";
import { ElizaTransactionsSection } from "./eliza-transactions-section";
import { ElizaWalletSection } from "./eliza-wallet-section";

const TABS = ["Overview", "Wallet", "Transactions", "Policies"] as const;
type Tab = (typeof TABS)[number];

interface ElizaAgentTabsProps {
  agentId: string;
  children: ReactNode; // Overview content
}

export function ElizaAgentTabs({ agentId, children }: ElizaAgentTabsProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const instanceId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const labels: Record<Tab, string> = {
    Overview: t("cloud.containers.agentTabs.overview", {
      defaultValue: "Overview",
    }),
    Wallet: t("cloud.containers.agentTabs.wallet", { defaultValue: "Wallet" }),
    Transactions: t("cloud.containers.agentTabs.transactions", {
      defaultValue: "Transactions",
    }),
    Policies: t("cloud.containers.agentTabs.policies", {
      defaultValue: "Policies",
    }),
  };

  const panels: Record<Tab, ReactNode> = {
    Overview: children,
    Wallet: <ElizaWalletSection agentId={agentId} />,
    Transactions: <ElizaTransactionsSection agentId={agentId} />,
    Policies: <ElizaPoliciesSection agentId={agentId} />,
  };

  const activateTab = (tab: Tab, index: number) => {
    setActiveTab(tab);
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + TABS.length) % TABS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(TABS[nextIndex], nextIndex);
  };

  const activeIndex = TABS.indexOf(activeTab);
  const activeTabId = `${instanceId}-tab-${activeIndex}`;
  const activePanelId = `${instanceId}-panel-${activeIndex}`;

  return (
    <div className="space-y-6">
      <div
        className="flex items-center gap-0 overflow-x-auto border-b border-white/10"
        role="tablist"
        aria-label={t("cloud.agents.detail.backToInstances", {
          defaultValue: "Agents",
        })}
      >
        {TABS.map((tab, index) => (
          <Button
            variant="ghost"
            key={tab}
            type="button"
            id={`${instanceId}-tab-${index}`}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`${instanceId}-panel-${index}`}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`relative shrink-0 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors ${
              activeTab === tab
                ? "text-txt-strong"
                : "text-white/60 hover:text-white/70"
            }`}
          >
            {labels[tab]}
            {activeTab === tab && (
              <span className="absolute bottom-0 left-0 right-0 h-px bg-txt" />
            )}
          </Button>
        ))}
      </div>

      <div id={activePanelId} role="tabpanel" aria-labelledby={activeTabId}>
        {panels[activeTab]}
      </div>
    </div>
  );
}
