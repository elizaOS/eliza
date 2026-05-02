/**
 * GET /api/crypto/status
 * Returns crypto-payment availability + supported tokens/networks.
 */

import { Hono } from "hono";
import {
  getSupportedNetworks,
  NETWORK_CONFIGS,
  SUPPORTED_PAY_CURRENCIES,
} from "@/lib/config/crypto";
import { isOxaPayConfigured } from "@/lib/services/oxapay";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  const enabled = isOxaPayConfigured();
  const networks = getSupportedNetworks().map((networkId) => {
    const config = NETWORK_CONFIGS[networkId];
    return { id: config.id, name: config.name };
  });
  return c.json({
    enabled,
    supportedTokens: [...SUPPORTED_PAY_CURRENCIES],
    networks,
    isTestnet: c.env.NODE_ENV !== "production",
  });
});

export default app;
