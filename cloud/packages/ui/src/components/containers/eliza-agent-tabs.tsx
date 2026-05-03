"use client";

import { type ReactNode, useState } from "react";
import { ElizaPoliciesSection } from "./eliza-policies-section";
import { ElizaTransactionsSection } from "./eliza-transactions-section";
import { ElizaWalletSection } from "./eliza-wallet-section";

const TABS = ["Overview", "Wallet", "Transactions", "Policies"] as const;
type Tab = (typeof TABS)[number];

interface ElizaAgentTabsProps {
  agentId: string;
  children: ReactNode; // Overview content (server-rendered)
}

export function ElizaAgentTabs({ agentId, children }: ElizaAgentTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("Overview");

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-white/10 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`relative shrink-0 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors ${
              activeTab === tab ? "text-[#FF5800]" : "text-white/40 hover:text-white/70"
            }`}
          >
            {tab}
            {activeTab === tab && (
              <span className="absolute bottom-0 left-0 right-0 h-px bg-[#FF5800]" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "Overview" && <>{children}</>}
        {activeTab === "Wallet" && <ElizaWalletSection agentId={agentId} />}
        {activeTab === "Transactions" && <ElizaTransactionsSection agentId={agentId} />}
        {activeTab === "Policies" && <ElizaPoliciesSection agentId={agentId} />}
      </div>
    </div>
  );
}
