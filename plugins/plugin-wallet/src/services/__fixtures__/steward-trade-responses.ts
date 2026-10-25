/**
 * Sanitized Steward trade route fixtures for the wallet trading client. Values
 * preserve the public `/v1/trade` envelope shapes emitted by the trading plugin
 * while replacing credentials, account keys, and live venue identifiers.
 */
export const stewardFixtures = {
  tokenStatusObserved: {
    ok: true,
    data: {
      agentId: "agent-fixture",
      status: "observed",
      exp: 1_799_999_999,
      observedAt: "2026-07-10T00:00:00.000Z",
      expiresInSeconds: 86_400,
    },
  },
  openHyperliquidSession: {
    ok: true,
    data: {
      sessionId: "sess_hl_fixture",
      expiresAt: "2026-07-10T01:00:00.000Z",
    },
  },
  activeHyperliquidSession: {
    ok: true,
    data: {
      id: "sess_hl_fixture",
      agentId: "agent-fixture",
      venue: "hyperliquid",
      walletId: "wallet_fixture",
      status: "active",
      dailySpendUsd: 0,
      dailyCapUsd: 300,
      perOrderCapUsd: 100,
      leverageCap: 5,
      allowedAssets: ["BTC", "ETH"],
      createdAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-10T01:00:00.000Z",
      revokedAt: null,
    },
  },
  hyperliquidOrderAccepted: {
    ok: true,
    data: {
      orderId: "hl_order_fixture",
      status: "submitted",
      filledQty: 0.01,
      avgPrice: 61_000,
      txHash: null,
      builderPerp: false,
    },
  },
  polymarketOrderAccepted: {
    ok: true,
    data: {
      orderId: "pm_order_fixture",
      status: "filled",
      filledQty: 12.34,
      avgPrice: 0.42,
      notionalUsd: 5.18,
    },
  },
  policyViolation: {
    code: "policy-violation",
    reason: "asset-allowlist: asset DOGE is not allowed for this session",
  },
  missingAgentPolicy: {
    code: "policy-violation",
    message:
      "agent has no trade policy; a human must set agent caps before self-service trading",
  },
  idempotencyConflict: {
    ok: false,
    error: "Idempotency key reused with a different body",
  },
  rateLimited: {
    ok: false,
    error: "Trade order rate limit exceeded",
  },
  unknownSubmit: {
    ok: false,
    error: "Trade submission status unknown",
  },
} as const;
