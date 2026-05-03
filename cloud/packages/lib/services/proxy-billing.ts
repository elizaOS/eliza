/** Proxy billing for blockchain API proxy endpoints. */

import { organizationsRepository } from "@/db/repositories";
import { creditsService } from "./credits";

const PROXY_PRICING: Readonly<Record<string, number>> = {
  birdeye: 0.001, // $0.001 per Birdeye API call
  helius: 0.0005, // $0.0005 per Helius RPC call
  alchemy: 0.0005, // $0.0005 per Alchemy RPC call
  "solana-rpc": 0.0003, // $0.0003 per Solana RPC call (enhanced via Helius)
  "evm-rpc": 0.0003, // $0.0003 per EVM RPC call (enhanced via Alchemy)
};

export function getProxyCost(service: string): number {
  return PROXY_PRICING[service] ?? 0.001;
}

export async function deductProxyCredits(params: {
  organizationId: string;
  userId?: string;
  service: string;
  path: string;
}): Promise<number> {
  const cost = getProxyCost(params.service);

  await creditsService.deductCredits({
    organizationId: params.organizationId,
    amount: cost,
    description: `API proxy: ${params.service} — ${params.path}`,
    metadata: {
      type: `proxy_${params.service}`,
      service: params.service,
      path: params.path,
    },
  });

  return cost;
}

export async function hasProxyCredits(organizationId: string, service: string): Promise<boolean> {
  const cost = getProxyCost(service);
  const org = await organizationsRepository.findById(organizationId);
  if (!org) return false;
  const balance = Number.parseFloat(String(org.credit_balance));
  return balance >= cost;
}

export const proxyBillingService = {
  getProxyCost,
  deductProxyCredits,
  hasProxyCredits,
};
