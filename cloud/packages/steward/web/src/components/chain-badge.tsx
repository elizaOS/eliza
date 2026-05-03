"use client";
import { getChainMeta } from "@/lib/chains";

export function ChainBadge({ chainId, compact }: { chainId: number; compact?: boolean }) {
  const meta = getChainMeta(chainId);
  if (!meta) return <span className="text-zinc-500 text-xs">Chain {chainId}</span>;

  return (
    <span className="inline-flex items-center gap-1 text-xs font-mono">
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }} />
      {compact ? meta.symbol : meta.name}
    </span>
  );
}
