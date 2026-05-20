"use client";

import { formatCompactCurrency } from "@feed/shared";
import { Loader2, Sparkles, Wallet } from "lucide-react";
import { useCallback, useState } from "react";
import { AgentWallet as SharedAgentWallet } from "@/components/agents/AgentWallet";
import { BuyPointsModal } from "@/components/points/BuyPointsModal";
import { useWalletBalance } from "@/hooks/useWalletBalance";

type AgentPortfolioProps =
  | {
      entityType: "agent";
      agentId: string;
      entityName: string;
      onUpdate?: () => void;
      userId?: never;
    }
  | {
      entityType: "user";
      userId: string;
      entityName: string;
      onUpdate?: () => void;
      agentId?: never;
    };

/**
 * Wallet component for viewing balance and managing transfers.
 * Supports both user and agent modes.
 * - User mode: Shows balance only (no transfers)
 * - Agent mode: Shows balance, transfers, and transaction history
 */
export function AgentPortfolio(props: AgentPortfolioProps) {
  const { entityType, entityName } = props;

  if (entityType === "user") {
    return (
      <UserWallet
        userId={props.userId}
        entityName={entityName}
        onUpdate={props.onUpdate}
      />
    );
  }

  return (
    <SharedAgentWallet
      agent={{ id: props.agentId, name: entityName }}
      onUpdate={props.onUpdate ?? (() => {})}
    />
  );
}

/** User wallet - balance only, no transfers */
function UserWallet({
  userId,
  entityName,
  onUpdate,
}: {
  userId: string;
  entityName: string;
  onUpdate?: () => void;
}) {
  const { balance, loading, refresh } = useWalletBalance(userId);
  const [buyPointsOpen, setBuyPointsOpen] = useState(false);

  const handleBuyPointsSuccess = useCallback(() => {
    refresh();
    onUpdate?.();
  }, [onUpdate, refresh]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Balance Card */}
      <div className="rounded-lg border border-[#0066FF]/30 bg-[#0066FF]/5 p-4">
        <div>
          <div className="flex items-center gap-1.5 text-[#0066FF] text-xs">
            <Wallet className="h-3.5 w-3.5" />
            Your Balance
          </div>
          <div className="mt-1 font-bold text-2xl">
            {formatCompactCurrency(balance)}
          </div>
        </div>
        <div className="mt-2 text-muted-foreground text-xs">{entityName}</div>
      </div>

      {/* Buy Points Button */}
      <button
        type="button"
        onClick={() => setBuyPointsOpen(true)}
        className="flex items-center justify-center gap-2 rounded-lg bg-[#0066FF] px-4 py-2.5 font-medium text-white transition-all hover:bg-[#0055DD]"
      >
        <Sparkles className="h-4 w-4" />
        Buy Points
      </button>

      {/* Buy Points Modal */}
      <BuyPointsModal
        isOpen={buyPointsOpen}
        onClose={() => setBuyPointsOpen(false)}
        onSuccess={handleBuyPointsSuccess}
      />
    </div>
  );
}
