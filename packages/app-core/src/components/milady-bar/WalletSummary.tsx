import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { useApp } from "../../state";

export function WalletSummary() {
  const { walletBalances, setTab } = useApp();

  const totalUsd = useMemo(() => {
    if (!walletBalances) return null;
    let sum = 0;

    if (walletBalances.evm) {
      for (const chain of walletBalances.evm.chains) {
        sum += parseFloat(chain.nativeValueUsd) || 0;
        for (const token of chain.tokens) {
          sum += parseFloat(token.valueUsd) || 0;
        }
      }
    }

    if (walletBalances.solana) {
      sum += parseFloat(walletBalances.solana.solValueUsd) || 0;
      for (const token of walletBalances.solana.tokens) {
        sum += parseFloat(token.valueUsd) || 0;
      }
    }

    return sum;
  }, [walletBalances]);

  if (totalUsd === null) {
    return (
      <span
        data-testid="milady-bar-wallet"
        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-muted"
      >
        <Wallet className="w-3 h-3" />
        Wallet
      </span>
    );
  }

  const formatted = totalUsd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <button
      type="button"
      data-testid="milady-bar-wallet"
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-mono text-txt transition-all hover:border-accent hover:text-txt cursor-pointer"
      onClick={() => setTab("wallets")}
    >
      <Wallet className="w-3 h-3" />
      {formatted}
    </button>
  );
}
