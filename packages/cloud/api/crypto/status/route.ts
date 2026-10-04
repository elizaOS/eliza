/**
 * GET /api/crypto/status
 * Returns crypto-payment availability + supported tokens/networks.
 */

import {
  getSupportedNetworks,
  NETWORK_CONFIGS,
  SUPPORTED_PAY_CURRENCIES,
} from "@elizaos/cloud-shared/lib/config/crypto";
import { directWalletPaymentsService } from "@elizaos/cloud-shared/lib/services/direct-wallet-payments";
import { isOxaPayConfigured } from "@elizaos/cloud-shared/lib/services/oxapay";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  const enabled = isOxaPayConfigured();
  const direct = directWalletPaymentsService.getConfig(c.env);
  const networks = getSupportedNetworks().map((networkId) => {
    const config = NETWORK_CONFIGS[networkId];
    return { id: config.id, name: config.name };
  });
  return c.json({
    enabled: enabled || direct.enabled,
    oxapayEnabled: enabled,
    directWallet: direct,
    supportedTokens: [...SUPPORTED_PAY_CURRENCIES],
    networks,
    isTestnet: c.env.NODE_ENV !== "production",
  });
});

export default app;
