import { NextResponse } from "next/server";
import { isOxaPayConfigured } from "@/lib/services/oxapay";
import {
  SUPPORTED_PAY_CURRENCIES,
  NETWORK_CONFIGS,
  getSupportedNetworks,
} from "@/lib/config/crypto";

export interface CryptoStatusResponse {
  enabled: boolean;
  supportedTokens: string[];
  networks: Array<{
    id: string;
    name: string;
  }>;
  isTestnet: boolean;
}

/**
 * GET /api/crypto/status
 * Returns the status of crypto payments and the list of supported tokens/networks.
 */
export async function GET(): Promise<NextResponse<CryptoStatusResponse>> {
  const enabled = isOxaPayConfigured();

  const networks = getSupportedNetworks().map((networkId) => {
    const config = NETWORK_CONFIGS[networkId];
    return {
      id: config.id,
      name: config.name,
    };
  });

  return NextResponse.json({
    enabled,
    supportedTokens: [...SUPPORTED_PAY_CURRENCIES],
    networks,
    isTestnet: process.env.NODE_ENV !== "production",
  });
}
