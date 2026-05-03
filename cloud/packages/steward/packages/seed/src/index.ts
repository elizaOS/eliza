import crypto, { createHash } from "node:crypto";
import { encodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  agents,
  approvalQueue,
  closeDb,
  encryptedKeys,
  getDb,
  getSql,
  policies,
  tenants,
  transactions,
} from "../../db/src/index.ts";
import { KeyStore } from "../../vault/src/index.ts";

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                  */
/* ──────────────────────────────────────────────────────────────────────────── */

const TENANT_ID = "waifu.fun";
const TENANT_NAME = "waifu.fun";
const DEMO_API_KEY = "stw_demo_waifu_fun_dashboard";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount)"]);

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Known addresses                                                            */
/* ──────────────────────────────────────────────────────────────────────────── */

const ADDR = {
  pancakeSwap: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4" as const,
  teamMultisig: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as const,
  elizaCloud: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD88" as const,
  aerodrome: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as const,
  polymarketCTF: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const,
  usdcPolygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const,
  hyperliquid: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as const,
  // addresses used in rejection scenarios
  deadAddress: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as const,
  uniswapRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const,
  randomContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
  wrongAddress: "0x1111111111111111111111111111111111111111" as const,
  unauthorizedBridge: "0x3333333333333333333333333333333333333333" as const,
};

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Types                                                                      */
/* ──────────────────────────────────────────────────────────────────────────── */

type PolicyResultSeed = {
  policyId: string;
  type:
    | "spending-limit"
    | "approved-addresses"
    | "auto-approve-threshold"
    | "time-window"
    | "rate-limit";
  passed: boolean;
  reason?: string;
};

type TransactionSeed = {
  id: string;
  agentId: string;
  status: "pending" | "approved" | "rejected" | "signed" | "broadcast" | "confirmed" | "failed";
  toAddress: `0x${string}`;
  value: string;
  data?: `0x${string}`;
  chainId: number;
  txHash?: `0x${string}`;
  policyResults: PolicyResultSeed[];
  createdAt: Date;
  signedAt?: Date;
  confirmedAt?: Date;
};

type ApprovalSeed = {
  id: string;
  txId: string;
  agentId: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
};

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                    */
/* ──────────────────────────────────────────────────────────────────────────── */

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function randomTxHash(): `0x${string}` {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

function createWallet() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function erc20Transfer(to: `0x${string}`, amountRaw: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amountRaw],
  });
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Clean only waifu.fun tenant data (preserve default tenant)                 */
/* ──────────────────────────────────────────────────────────────────────────── */

async function cleanWaifuData() {
  const sql = getSql();
  // Order matters: children first due to FK constraints
  await sql`DELETE FROM approval_queue WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ${TENANT_ID})`;
  await sql`DELETE FROM transactions WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ${TENANT_ID})`;
  await sql`DELETE FROM policies WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ${TENANT_ID})`;
  await sql`DELETE FROM encrypted_keys WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ${TENANT_ID})`;
  await sql`DELETE FROM agents WHERE tenant_id = ${TENANT_ID}`;
  // Don't delete the tenant itself — we upsert it below
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Seed function                                                              */
/* ──────────────────────────────────────────────────────────────────────────── */

async function seed() {
  if (!process.env.STEWARD_MASTER_PASSWORD) {
    throw new Error("STEWARD_MASTER_PASSWORD is required");
  }

  const db = getDb();
  const keyStore = new KeyStore(process.env.STEWARD_MASTER_PASSWORD);
  const createdAt = hoursAgo(168); // 7 days ago — agent creation time
  const updatedAt = hoursAgo(1);

  console.log("Cleaning existing waifu.fun data...");
  await cleanWaifuData();

  /* ── Tenant upsert ─────────────────────────────────────────────────────── */
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: TENANT_NAME,
      apiKeyHash: hashApiKey(DEMO_API_KEY),
      createdAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: tenants.id,
      set: {
        name: TENANT_NAME,
        apiKeyHash: hashApiKey(DEMO_API_KEY),
        updatedAt,
      },
    });

  /* ════════════════════════════════════════════════════════════════════════ */
  /*  AGENT DEFINITIONS                                                      */
  /* ════════════════════════════════════════════════════════════════════════ */

  const agentDefs = [
    {
      id: "agent-treasury-ops",
      name: "treasury-ops",
      platformId: "waifu-platform-treasury",
    },
    {
      id: "agent-dex-trader",
      name: "dex-trader",
      platformId: "waifu-dex-alpha",
    },
    {
      id: "agent-prediction-agent",
      name: "prediction-agent",
      platformId: "waifu-oracle-v1",
    },
    {
      id: "agent-perp-trader",
      name: "perp-trader",
      platformId: "waifu-perp-alpha",
    },
    {
      id: "agent-hosting-payer",
      name: "hosting-payer",
      platformId: "waifu-infra-billing",
    },
  ];

  const agentRows = [];
  const encryptedKeyRows = [];

  for (const agent of agentDefs) {
    const wallet = createWallet();
    const encrypted = keyStore.encrypt(wallet.privateKey);

    agentRows.push({
      id: agent.id,
      tenantId: TENANT_ID,
      name: agent.name,
      walletAddress: wallet.address,
      platformId: agent.platformId,
      createdAt,
      updatedAt,
    });

    encryptedKeyRows.push({
      agentId: agent.id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      salt: encrypted.salt,
    });
  }

  await db.insert(agents).values(agentRows).onConflictDoNothing({ target: agents.id });
  await db
    .insert(encryptedKeys)
    .values(encryptedKeyRows)
    .onConflictDoNothing({ target: encryptedKeys.agentId });

  /* ════════════════════════════════════════════════════════════════════════ */
  /*  POLICIES                                                               */
  /* ════════════════════════════════════════════════════════════════════════ */

  const policySeeds = [
    /* ── treasury-ops ──────────────────────────────────────────────────── */
    {
      id: "pol-treasury-spending",
      agentId: "agent-treasury-ops",
      type: "spending-limit" as const,
      enabled: true,
      config: {
        maxPerTx: "2000000000000000000", // 2 BNB
        maxPerDay: "10000000000000000000", // 10 BNB
        maxPerWeek: "50000000000000000000", // 50 BNB
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-treasury-addresses",
      agentId: "agent-treasury-ops",
      type: "approved-addresses" as const,
      enabled: true,
      config: {
        addresses: [ADDR.pancakeSwap, ADDR.teamMultisig, ADDR.elizaCloud],
        mode: "whitelist",
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-treasury-auto",
      agentId: "agent-treasury-ops",
      type: "auto-approve-threshold" as const,
      enabled: true,
      config: { threshold: "500000000000000000" }, // 0.5 BNB
      createdAt,
      updatedAt,
    },
    {
      id: "pol-treasury-rate",
      agentId: "agent-treasury-ops",
      type: "rate-limit" as const,
      enabled: true,
      config: { maxTxPerHour: 20, maxTxPerDay: 100 },
      createdAt,
      updatedAt,
    },

    /* ── dex-trader ────────────────────────────────────────────────────── */
    {
      id: "pol-dex-spending",
      agentId: "agent-dex-trader",
      type: "spending-limit" as const,
      enabled: true,
      config: {
        maxPerTx: "1000000000000000000", // 1 ETH/BNB
        maxPerDay: "5000000000000000000", // 5
        maxPerWeek: "20000000000000000000", // 20
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-dex-addresses",
      agentId: "agent-dex-trader",
      type: "approved-addresses" as const,
      enabled: true,
      config: {
        addresses: [ADDR.pancakeSwap, ADDR.aerodrome],
        mode: "whitelist",
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-dex-auto",
      agentId: "agent-dex-trader",
      type: "auto-approve-threshold" as const,
      enabled: true,
      config: { threshold: "200000000000000000" }, // 0.2
      createdAt,
      updatedAt,
    },
    {
      id: "pol-dex-window",
      agentId: "agent-dex-trader",
      type: "time-window" as const,
      enabled: true,
      config: {
        allowedHours: [{ start: 6, end: 22 }],
        allowedDays: [1, 2, 3, 4, 5],
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-dex-rate",
      agentId: "agent-dex-trader",
      type: "rate-limit" as const,
      enabled: true,
      config: { maxTxPerHour: 50, maxTxPerDay: 200 },
      createdAt,
      updatedAt,
    },

    /* ── prediction-agent ──────────────────────────────────────────────── */
    {
      id: "pol-pred-spending",
      agentId: "agent-prediction-agent",
      type: "spending-limit" as const,
      enabled: true,
      config: {
        maxPerTx: "150000000000000000000", // 150 POL
        maxPerDay: "500000000000000000000", // 500 POL
        maxPerWeek: "2000000000000000000000", // 2000 POL
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-pred-addresses",
      agentId: "agent-prediction-agent",
      type: "approved-addresses" as const,
      enabled: true,
      config: {
        addresses: [ADDR.polymarketCTF, ADDR.usdcPolygon],
        mode: "whitelist",
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-pred-auto",
      agentId: "agent-prediction-agent",
      type: "auto-approve-threshold" as const,
      enabled: true,
      config: { threshold: "20000000000000000000" }, // 20 POL
      createdAt,
      updatedAt,
    },
    {
      id: "pol-pred-rate",
      agentId: "agent-prediction-agent",
      type: "rate-limit" as const,
      enabled: true,
      config: { maxTxPerHour: 30, maxTxPerDay: 100 },
      createdAt,
      updatedAt,
    },

    /* ── perp-trader ───────────────────────────────────────────────────── */
    {
      id: "pol-perp-spending",
      agentId: "agent-perp-trader",
      type: "spending-limit" as const,
      enabled: true,
      config: {
        maxPerTx: "500000000000000000", // 0.5 ETH
        maxPerDay: "2000000000000000000", // 2 ETH
        maxPerWeek: "10000000000000000000", // 10 ETH
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-perp-addresses",
      agentId: "agent-perp-trader",
      type: "approved-addresses" as const,
      enabled: true,
      config: {
        addresses: [ADDR.hyperliquid],
        mode: "whitelist",
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-perp-auto",
      agentId: "agent-perp-trader",
      type: "auto-approve-threshold" as const,
      enabled: true,
      config: { threshold: "50000000000000000" }, // 0.05 ETH
      createdAt,
      updatedAt,
    },
    {
      id: "pol-perp-rate",
      agentId: "agent-perp-trader",
      type: "rate-limit" as const,
      enabled: true,
      config: { maxTxPerHour: 100, maxTxPerDay: 500 },
      createdAt,
      updatedAt,
    },

    /* ── hosting-payer ─────────────────────────────────────────────────── */
    {
      id: "pol-hosting-spending",
      agentId: "agent-hosting-payer",
      type: "spending-limit" as const,
      enabled: true,
      config: {
        maxPerTx: "500000000000000000", // 0.5 BNB
        maxPerDay: "1000000000000000000", // 1 BNB
        maxPerWeek: "2000000000000000000", // 2 BNB
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-hosting-addresses",
      agentId: "agent-hosting-payer",
      type: "approved-addresses" as const,
      enabled: true,
      config: {
        addresses: [ADDR.elizaCloud],
        mode: "whitelist",
      },
      createdAt,
      updatedAt,
    },
    {
      id: "pol-hosting-auto",
      agentId: "agent-hosting-payer",
      type: "auto-approve-threshold" as const,
      enabled: true,
      config: { threshold: "100000000000000000" }, // 0.1 BNB
      createdAt,
      updatedAt,
    },
    {
      id: "pol-hosting-rate",
      agentId: "agent-hosting-payer",
      type: "rate-limit" as const,
      enabled: true,
      config: { maxTxPerHour: 5, maxTxPerDay: 10 },
      createdAt,
      updatedAt,
    },
  ];

  await db.insert(policies).values(policySeeds).onConflictDoNothing({ target: policies.id });

  /* ════════════════════════════════════════════════════════════════════════ */
  /*  TRANSACTIONS                                                           */
  /* ════════════════════════════════════════════════════════════════════════ */

  // Helper to build all-pass policy results for a given agent
  function treasuryAllPass(): PolicyResultSeed[] {
    return [
      {
        policyId: "pol-treasury-spending",
        type: "spending-limit",
        passed: true,
      },
      {
        policyId: "pol-treasury-addresses",
        type: "approved-addresses",
        passed: true,
      },
      {
        policyId: "pol-treasury-auto",
        type: "auto-approve-threshold",
        passed: true,
      },
      { policyId: "pol-treasury-rate", type: "rate-limit", passed: true },
    ];
  }

  function dexAllPass(): PolicyResultSeed[] {
    return [
      { policyId: "pol-dex-spending", type: "spending-limit", passed: true },
      {
        policyId: "pol-dex-addresses",
        type: "approved-addresses",
        passed: true,
      },
      {
        policyId: "pol-dex-auto",
        type: "auto-approve-threshold",
        passed: true,
      },
      { policyId: "pol-dex-window", type: "time-window", passed: true },
      { policyId: "pol-dex-rate", type: "rate-limit", passed: true },
    ];
  }

  function predAllPass(): PolicyResultSeed[] {
    return [
      { policyId: "pol-pred-spending", type: "spending-limit", passed: true },
      {
        policyId: "pol-pred-addresses",
        type: "approved-addresses",
        passed: true,
      },
      {
        policyId: "pol-pred-auto",
        type: "auto-approve-threshold",
        passed: true,
      },
      { policyId: "pol-pred-rate", type: "rate-limit", passed: true },
    ];
  }

  function perpAllPass(): PolicyResultSeed[] {
    return [
      { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
      {
        policyId: "pol-perp-addresses",
        type: "approved-addresses",
        passed: true,
      },
      {
        policyId: "pol-perp-auto",
        type: "auto-approve-threshold",
        passed: true,
      },
      { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
    ];
  }

  function hostingAllPass(): PolicyResultSeed[] {
    return [
      {
        policyId: "pol-hosting-spending",
        type: "spending-limit",
        passed: true,
      },
      {
        policyId: "pol-hosting-addresses",
        type: "approved-addresses",
        passed: true,
      },
      {
        policyId: "pol-hosting-auto",
        type: "auto-approve-threshold",
        passed: true,
      },
      { policyId: "pol-hosting-rate", type: "rate-limit", passed: true },
    ];
  }

  const txSeeds: TransactionSeed[] = [
    /* ══════════════════════════════════════════════════════════════════════ */
    /*  1. treasury-ops — 12 transactions (BSC 56)                           */
    /* ══════════════════════════════════════════════════════════════════════ */

    // 5x confirmed: payroll/ops transfers to team multisig (0.3–0.4 BNB)
    {
      id: "tx-treasury-001",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.teamMultisig,
      value: "300000000000000000", // 0.3 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(156), // ~6.5 days ago
      signedAt: hoursAgo(155.9),
      confirmedAt: hoursAgo(155.8),
    },
    {
      id: "tx-treasury-002",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.teamMultisig,
      value: "350000000000000000", // 0.35 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(132), // ~5.5 days ago
      signedAt: hoursAgo(131.9),
      confirmedAt: hoursAgo(131.7),
    },
    {
      id: "tx-treasury-003",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.teamMultisig,
      value: "400000000000000000", // 0.4 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(108), // ~4.5 days ago
      signedAt: hoursAgo(107.9),
      confirmedAt: hoursAgo(107.7),
    },
    {
      id: "tx-treasury-004",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.teamMultisig,
      value: "320000000000000000", // 0.32 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(84), // ~3.5 days ago
      signedAt: hoursAgo(83.9),
      confirmedAt: hoursAgo(83.7),
    },
    {
      id: "tx-treasury-005",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.teamMultisig,
      value: "380000000000000000", // 0.38 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(36), // ~1.5 days ago
      signedAt: hoursAgo(35.9),
      confirmedAt: hoursAgo(35.7),
    },

    // 2x confirmed: PancakeSwap swaps (0.8 BNB, 1.2 BNB) — above auto-approve, human approved
    {
      id: "tx-treasury-006",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "800000000000000000", // 0.8 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: [
        {
          policyId: "pol-treasury-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-treasury-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-treasury-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.8 BNB exceeds auto-approve threshold of 0.5 BNB",
        },
        { policyId: "pol-treasury-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(120), // 5 days ago
      signedAt: hoursAgo(119.5),
      confirmedAt: hoursAgo(119.3),
    },
    {
      id: "tx-treasury-007",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "1200000000000000000", // 1.2 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: [
        {
          policyId: "pol-treasury-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-treasury-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-treasury-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 1.2 BNB exceeds auto-approve threshold of 0.5 BNB",
        },
        { policyId: "pol-treasury-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(60), // 2.5 days ago
      signedAt: hoursAgo(59.5),
      confirmedAt: hoursAgo(59.3),
    },

    // 1x rejected: transfer to unknown address (approved-addresses failed)
    {
      id: "tx-treasury-008",
      agentId: "agent-treasury-ops",
      status: "rejected",
      toAddress: ADDR.deadAddress,
      value: "500000000000000000", // 0.5 BNB
      chainId: 56,
      policyResults: [
        {
          policyId: "pol-treasury-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-treasury-addresses",
          type: "approved-addresses",
          passed: false,
          reason: "destination 0xdead...dead not on whitelist",
        },
        {
          policyId: "pol-treasury-auto",
          type: "auto-approve-threshold",
          passed: true,
        },
        { policyId: "pol-treasury-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(96), // 4 days ago
    },

    // 1x rejected: exceeded daily limit (tried 8 BNB after spending 5)
    {
      id: "tx-treasury-009",
      agentId: "agent-treasury-ops",
      status: "rejected",
      toAddress: ADDR.teamMultisig,
      value: "8000000000000000000", // 8 BNB
      chainId: 56,
      policyResults: [
        {
          policyId: "pol-treasury-spending",
          type: "spending-limit",
          passed: false,
          reason: "daily spend 5.0 BNB + requested 8.0 BNB exceeds 10 BNB daily limit",
        },
        {
          policyId: "pol-treasury-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-treasury-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 8.0 BNB exceeds auto-approve threshold of 0.5 BNB",
        },
        { policyId: "pol-treasury-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(48), // 2 days ago
    },

    // 1x pending: large withdrawal 1.8 BNB to team multisig (above auto-approve)
    {
      id: "tx-treasury-010",
      agentId: "agent-treasury-ops",
      status: "pending",
      toAddress: ADDR.teamMultisig,
      value: "1800000000000000000", // 1.8 BNB
      chainId: 56,
      policyResults: [
        {
          policyId: "pol-treasury-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-treasury-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-treasury-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason:
            "value 1.8 BNB exceeds auto-approve threshold of 0.5 BNB — requires human approval",
        },
        { policyId: "pol-treasury-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(3),
    },

    // 2x confirmed: Eliza Cloud hosting payments (0.15 BNB each)
    {
      id: "tx-treasury-011",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "150000000000000000", // 0.15 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(144), // 6 days ago
      signedAt: hoursAgo(143.9),
      confirmedAt: hoursAgo(143.7),
    },
    {
      id: "tx-treasury-012",
      agentId: "agent-treasury-ops",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "150000000000000000", // 0.15 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: treasuryAllPass(),
      createdAt: hoursAgo(24), // 1 day ago
      signedAt: hoursAgo(23.9),
      confirmedAt: hoursAgo(23.7),
    },

    /* ══════════════════════════════════════════════════════════════════════ */
    /*  2. dex-trader — 15 transactions (BSC 56 + Base 8453)                 */
    /* ══════════════════════════════════════════════════════════════════════ */

    // 8x confirmed: small auto-approved swaps (0.05–0.18 BNB/ETH)
    {
      id: "tx-dex-001",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "50000000000000000", // 0.05 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(160),
      signedAt: hoursAgo(159.9),
      confirmedAt: hoursAgo(159.8),
    },
    {
      id: "tx-dex-002",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.aerodrome,
      value: "120000000000000000", // 0.12 ETH
      chainId: 8453,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(148),
      signedAt: hoursAgo(147.9),
      confirmedAt: hoursAgo(147.8),
    },
    {
      id: "tx-dex-003",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "80000000000000000", // 0.08 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(130),
      signedAt: hoursAgo(129.9),
      confirmedAt: hoursAgo(129.8),
    },
    {
      id: "tx-dex-004",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.aerodrome,
      value: "180000000000000000", // 0.18 ETH
      chainId: 8453,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(110),
      signedAt: hoursAgo(109.9),
      confirmedAt: hoursAgo(109.8),
    },
    {
      id: "tx-dex-005",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "150000000000000000", // 0.15 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(90),
      signedAt: hoursAgo(89.9),
      confirmedAt: hoursAgo(89.8),
    },
    {
      id: "tx-dex-006",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.aerodrome,
      value: "70000000000000000", // 0.07 ETH
      chainId: 8453,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(72),
      signedAt: hoursAgo(71.9),
      confirmedAt: hoursAgo(71.8),
    },
    {
      id: "tx-dex-007",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "100000000000000000", // 0.1 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(48),
      signedAt: hoursAgo(47.9),
      confirmedAt: hoursAgo(47.8),
    },
    {
      id: "tx-dex-008",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.aerodrome,
      value: "160000000000000000", // 0.16 ETH
      chainId: 8453,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(28),
      signedAt: hoursAgo(27.9),
      confirmedAt: hoursAgo(27.8),
    },

    // 2x confirmed: human-approved larger swaps (0.5 BNB, 0.7 ETH)
    {
      id: "tx-dex-009",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "500000000000000000", // 0.5 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-dex-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-dex-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-dex-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.5 BNB exceeds auto-approve threshold of 0.2 BNB",
        },
        { policyId: "pol-dex-window", type: "time-window", passed: true },
        { policyId: "pol-dex-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(100),
      signedAt: hoursAgo(99.5),
      confirmedAt: hoursAgo(99.3),
    },
    {
      id: "tx-dex-010",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.aerodrome,
      value: "700000000000000000", // 0.7 ETH
      chainId: 8453,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-dex-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-dex-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-dex-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.7 ETH exceeds auto-approve threshold of 0.2 ETH",
        },
        { policyId: "pol-dex-window", type: "time-window", passed: true },
        { policyId: "pol-dex-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(56),
      signedAt: hoursAgo(55.5),
      confirmedAt: hoursAgo(55.3),
    },

    // 1x rejected: attempted trade on Saturday (time-window failed)
    {
      id: "tx-dex-011",
      agentId: "agent-dex-trader",
      status: "rejected",
      toAddress: ADDR.pancakeSwap,
      value: "150000000000000000", // 0.15 BNB
      chainId: 56,
      policyResults: [
        { policyId: "pol-dex-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-dex-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-dex-auto",
          type: "auto-approve-threshold",
          passed: true,
        },
        {
          policyId: "pol-dex-window",
          type: "time-window",
          passed: false,
          reason: "transaction submitted on Saturday — trading restricted to weekdays (Mon-Fri)",
        },
        { policyId: "pol-dex-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(42), // ~1.75 days ago
    },

    // 1x rejected: tried Uniswap (address not whitelisted)
    {
      id: "tx-dex-012",
      agentId: "agent-dex-trader",
      status: "rejected",
      toAddress: ADDR.uniswapRouter,
      value: "300000000000000000", // 0.3 ETH
      chainId: 8453,
      policyResults: [
        { policyId: "pol-dex-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-dex-addresses",
          type: "approved-addresses",
          passed: false,
          reason: "destination 0x7a250d56...488D (Uniswap Router) not on approved whitelist",
        },
        {
          policyId: "pol-dex-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.3 ETH exceeds auto-approve threshold of 0.2 ETH",
        },
        { policyId: "pol-dex-window", type: "time-window", passed: true },
        { policyId: "pol-dex-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(18),
    },

    // 1x pending: large trade 0.9 ETH on Aerodrome awaiting approval
    {
      id: "tx-dex-013",
      agentId: "agent-dex-trader",
      status: "pending",
      toAddress: ADDR.aerodrome,
      value: "900000000000000000", // 0.9 ETH
      chainId: 8453,
      policyResults: [
        { policyId: "pol-dex-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-dex-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-dex-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason:
            "value 0.9 ETH exceeds auto-approve threshold of 0.2 ETH — requires human approval",
        },
        { policyId: "pol-dex-window", type: "time-window", passed: true },
        { policyId: "pol-dex-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(2),
    },

    // 2x confirmed: with ERC20 transfer calldata
    {
      id: "tx-dex-014",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.pancakeSwap,
      value: "0",
      data: erc20Transfer(ADDR.pancakeSwap, 500000000000000000n), // 0.5 token (18 dec)
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(66),
      signedAt: hoursAgo(65.9),
      confirmedAt: hoursAgo(65.8),
    },
    {
      id: "tx-dex-015",
      agentId: "agent-dex-trader",
      status: "confirmed",
      toAddress: ADDR.aerodrome,
      value: "0",
      data: erc20Transfer(ADDR.aerodrome, 250000000000000000n), // 0.25 token
      chainId: 8453,
      txHash: randomTxHash(),
      policyResults: dexAllPass(),
      createdAt: hoursAgo(14),
      signedAt: hoursAgo(13.9),
      confirmedAt: hoursAgo(13.8),
    },

    /* ══════════════════════════════════════════════════════════════════════ */
    /*  3. prediction-agent — 10 transactions (Polygon 137)                  */
    /* ══════════════════════════════════════════════════════════════════════ */

    // 5x confirmed: small bets (5–15 POL), some with ERC20 calldata
    {
      id: "tx-pred-001",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.polymarketCTF,
      value: "5000000000000000000", // 5 POL
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: predAllPass(),
      createdAt: hoursAgo(158),
      signedAt: hoursAgo(157.9),
      confirmedAt: hoursAgo(157.8),
    },
    {
      id: "tx-pred-002",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.usdcPolygon,
      value: "0",
      data: erc20Transfer(ADDR.polymarketCTF, 10000000n), // 10 USDC (6 decimals)
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: predAllPass(),
      createdAt: hoursAgo(140),
      signedAt: hoursAgo(139.9),
      confirmedAt: hoursAgo(139.7),
    },
    {
      id: "tx-pred-003",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.polymarketCTF,
      value: "12000000000000000000", // 12 POL
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: predAllPass(),
      createdAt: hoursAgo(115),
      signedAt: hoursAgo(114.9),
      confirmedAt: hoursAgo(114.7),
    },
    {
      id: "tx-pred-004",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.polymarketCTF,
      value: "8000000000000000000", // 8 POL
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: predAllPass(),
      createdAt: hoursAgo(88),
      signedAt: hoursAgo(87.9),
      confirmedAt: hoursAgo(87.7),
    },
    {
      id: "tx-pred-005",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.usdcPolygon,
      value: "0",
      data: erc20Transfer(ADDR.polymarketCTF, 15000000n), // 15 USDC
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: predAllPass(),
      createdAt: hoursAgo(52),
      signedAt: hoursAgo(51.9),
      confirmedAt: hoursAgo(51.7),
    },

    // 2x confirmed: human-approved larger positions (80 POL, 120 POL)
    {
      id: "tx-pred-006",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.polymarketCTF,
      value: "80000000000000000000", // 80 POL
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-pred-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-pred-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-pred-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 80 POL exceeds auto-approve threshold of 20 POL",
        },
        { policyId: "pol-pred-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(70),
      signedAt: hoursAgo(69.2),
      confirmedAt: hoursAgo(69),
    },
    {
      id: "tx-pred-007",
      agentId: "agent-prediction-agent",
      status: "confirmed",
      toAddress: ADDR.polymarketCTF,
      value: "120000000000000000000", // 120 POL
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-pred-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-pred-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-pred-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 120 POL exceeds auto-approve threshold of 20 POL",
        },
        { policyId: "pol-pred-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(30),
      signedAt: hoursAgo(29.5),
      confirmedAt: hoursAgo(29.3),
    },

    // 1x rejected: unapproved contract
    {
      id: "tx-pred-008",
      agentId: "agent-prediction-agent",
      status: "rejected",
      toAddress: ADDR.randomContract,
      value: "25000000000000000000", // 25 POL
      chainId: 137,
      policyResults: [
        { policyId: "pol-pred-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-pred-addresses",
          type: "approved-addresses",
          passed: false,
          reason: "destination 0xA0b86991...eB48 not on approved whitelist",
        },
        {
          policyId: "pol-pred-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 25 POL exceeds auto-approve threshold of 20 POL",
        },
        { policyId: "pol-pred-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(44),
    },

    // 1x pending: 90 POL awaiting approval
    {
      id: "tx-pred-009",
      agentId: "agent-prediction-agent",
      status: "pending",
      toAddress: ADDR.polymarketCTF,
      value: "90000000000000000000", // 90 POL
      chainId: 137,
      policyResults: [
        { policyId: "pol-pred-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-pred-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-pred-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 90 POL exceeds auto-approve threshold of 20 POL — requires human approval",
        },
        { policyId: "pol-pred-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(4),
    },

    // 1x failed: tx reverted on-chain (insufficient allowance)
    {
      id: "tx-pred-010",
      agentId: "agent-prediction-agent",
      status: "failed",
      toAddress: ADDR.polymarketCTF,
      value: "15000000000000000000", // 15 POL
      chainId: 137,
      txHash: randomTxHash(),
      policyResults: predAllPass(),
      createdAt: hoursAgo(20),
      signedAt: hoursAgo(19.9),
    },

    /* ══════════════════════════════════════════════════════════════════════ */
    /*  4. perp-trader — 18 transactions (Arbitrum 42161)                    */
    /* ══════════════════════════════════════════════════════════════════════ */

    // 10x confirmed: small auto-approved trades (0.01–0.04 ETH)
    {
      id: "tx-perp-001",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "10000000000000000", // 0.01 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(165),
      signedAt: hoursAgo(164.9),
      confirmedAt: hoursAgo(164.8),
    },
    {
      id: "tx-perp-002",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "25000000000000000", // 0.025 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(155),
      signedAt: hoursAgo(154.9),
      confirmedAt: hoursAgo(154.8),
    },
    {
      id: "tx-perp-003",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "40000000000000000", // 0.04 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(145),
      signedAt: hoursAgo(144.9),
      confirmedAt: hoursAgo(144.8),
    },
    {
      id: "tx-perp-004",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "15000000000000000", // 0.015 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(130),
      signedAt: hoursAgo(129.9),
      confirmedAt: hoursAgo(129.8),
    },
    {
      id: "tx-perp-005",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "30000000000000000", // 0.03 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(115),
      signedAt: hoursAgo(114.9),
      confirmedAt: hoursAgo(114.8),
    },
    {
      id: "tx-perp-006",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "20000000000000000", // 0.02 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(100),
      signedAt: hoursAgo(99.9),
      confirmedAt: hoursAgo(99.8),
    },
    {
      id: "tx-perp-007",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "35000000000000000", // 0.035 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(80),
      signedAt: hoursAgo(79.9),
      confirmedAt: hoursAgo(79.8),
    },
    {
      id: "tx-perp-008",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "12000000000000000", // 0.012 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(55),
      signedAt: hoursAgo(54.9),
      confirmedAt: hoursAgo(54.8),
    },
    {
      id: "tx-perp-009",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "45000000000000000", // 0.045 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(32),
      signedAt: hoursAgo(31.9),
      confirmedAt: hoursAgo(31.8),
    },
    {
      id: "tx-perp-010",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "18000000000000000", // 0.018 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: perpAllPass(),
      createdAt: hoursAgo(12),
      signedAt: hoursAgo(11.9),
      confirmedAt: hoursAgo(11.8),
    },

    // 3x confirmed: human-approved medium trades (0.1, 0.2, 0.3 ETH)
    {
      id: "tx-perp-011",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "100000000000000000", // 0.1 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.1 ETH exceeds auto-approve threshold of 0.05 ETH",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(120),
      signedAt: hoursAgo(119.2),
      confirmedAt: hoursAgo(119),
    },
    {
      id: "tx-perp-012",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "200000000000000000", // 0.2 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.2 ETH exceeds auto-approve threshold of 0.05 ETH",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(68),
      signedAt: hoursAgo(67.5),
      confirmedAt: hoursAgo(67.3),
    },
    {
      id: "tx-perp-013",
      agentId: "agent-perp-trader",
      status: "confirmed",
      toAddress: ADDR.hyperliquid,
      value: "300000000000000000", // 0.3 ETH
      chainId: 42161,
      txHash: randomTxHash(),
      policyResults: [
        { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.3 ETH exceeds auto-approve threshold of 0.05 ETH",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(24),
      signedAt: hoursAgo(23.3),
      confirmedAt: hoursAgo(23.1),
    },

    // 2x rejected: exceeded daily spending limit
    {
      id: "tx-perp-014",
      agentId: "agent-perp-trader",
      status: "rejected",
      toAddress: ADDR.hyperliquid,
      value: "400000000000000000", // 0.4 ETH
      chainId: 42161,
      policyResults: [
        {
          policyId: "pol-perp-spending",
          type: "spending-limit",
          passed: false,
          reason: "daily spend 1.8 ETH + requested 0.4 ETH exceeds 2 ETH daily limit",
        },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.4 ETH exceeds auto-approve threshold of 0.05 ETH",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(40),
    },
    {
      id: "tx-perp-015",
      agentId: "agent-perp-trader",
      status: "rejected",
      toAddress: ADDR.hyperliquid,
      value: "450000000000000000", // 0.45 ETH
      chainId: 42161,
      policyResults: [
        {
          policyId: "pol-perp-spending",
          type: "spending-limit",
          passed: false,
          reason: "daily spend 1.7 ETH + requested 0.45 ETH exceeds 2 ETH daily limit",
        },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.45 ETH exceeds auto-approve threshold of 0.05 ETH",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(16),
    },

    // 1x rejected: tried to bridge to unauthorized address
    {
      id: "tx-perp-016",
      agentId: "agent-perp-trader",
      status: "rejected",
      toAddress: ADDR.unauthorizedBridge,
      value: "150000000000000000", // 0.15 ETH
      chainId: 42161,
      policyResults: [
        { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: false,
          reason:
            "destination 0x3333...3333 not on approved whitelist — only Hyperliquid Bridge allowed",
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.15 ETH exceeds auto-approve threshold of 0.05 ETH",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(50),
    },

    // 2x pending: positions awaiting human review (0.2 ETH, 0.35 ETH)
    {
      id: "tx-perp-017",
      agentId: "agent-perp-trader",
      status: "pending",
      toAddress: ADDR.hyperliquid,
      value: "200000000000000000", // 0.2 ETH
      chainId: 42161,
      policyResults: [
        { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason:
            "value 0.2 ETH exceeds auto-approve threshold of 0.05 ETH — requires human approval",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(5),
    },
    {
      id: "tx-perp-018",
      agentId: "agent-perp-trader",
      status: "pending",
      toAddress: ADDR.hyperliquid,
      value: "350000000000000000", // 0.35 ETH
      chainId: 42161,
      policyResults: [
        { policyId: "pol-perp-spending", type: "spending-limit", passed: true },
        {
          policyId: "pol-perp-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-perp-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason:
            "value 0.35 ETH exceeds auto-approve threshold of 0.05 ETH — requires human approval",
        },
        { policyId: "pol-perp-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(1.5),
    },

    /* ══════════════════════════════════════════════════════════════════════ */
    /*  5. hosting-payer — 8 transactions (BSC 56)                           */
    /* ══════════════════════════════════════════════════════════════════════ */

    // 5x confirmed: regular hosting payments (0.05–0.08 BNB), spread evenly
    {
      id: "tx-hosting-001",
      agentId: "agent-hosting-payer",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "50000000000000000", // 0.05 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: hostingAllPass(),
      createdAt: hoursAgo(162), // ~6.75 days ago
      signedAt: hoursAgo(161.9),
      confirmedAt: hoursAgo(161.7),
    },
    {
      id: "tx-hosting-002",
      agentId: "agent-hosting-payer",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "65000000000000000", // 0.065 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: hostingAllPass(),
      createdAt: hoursAgo(130), // ~5.4 days ago
      signedAt: hoursAgo(129.9),
      confirmedAt: hoursAgo(129.7),
    },
    {
      id: "tx-hosting-003",
      agentId: "agent-hosting-payer",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "70000000000000000", // 0.07 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: hostingAllPass(),
      createdAt: hoursAgo(98), // ~4.1 days ago
      signedAt: hoursAgo(97.9),
      confirmedAt: hoursAgo(97.7),
    },
    {
      id: "tx-hosting-004",
      agentId: "agent-hosting-payer",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "80000000000000000", // 0.08 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: hostingAllPass(),
      createdAt: hoursAgo(66), // ~2.75 days ago
      signedAt: hoursAgo(65.9),
      confirmedAt: hoursAgo(65.7),
    },
    {
      id: "tx-hosting-005",
      agentId: "agent-hosting-payer",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "60000000000000000", // 0.06 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: hostingAllPass(),
      createdAt: hoursAgo(34), // ~1.4 days ago
      signedAt: hoursAgo(33.9),
      confirmedAt: hoursAgo(33.7),
    },

    // 1x rejected: payment to wrong address (copy-paste error)
    {
      id: "tx-hosting-006",
      agentId: "agent-hosting-payer",
      status: "rejected",
      toAddress: ADDR.wrongAddress,
      value: "75000000000000000", // 0.075 BNB
      chainId: 56,
      policyResults: [
        {
          policyId: "pol-hosting-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-hosting-addresses",
          type: "approved-addresses",
          passed: false,
          reason: "destination 0x1111...1111 not on whitelist — only Eliza Cloud address allowed",
        },
        {
          policyId: "pol-hosting-auto",
          type: "auto-approve-threshold",
          passed: true,
        },
        { policyId: "pol-hosting-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(78), // ~3.25 days ago
    },

    // 1x pending: larger-than-usual bill 0.3 BNB awaiting approval
    {
      id: "tx-hosting-007",
      agentId: "agent-hosting-payer",
      status: "pending",
      toAddress: ADDR.elizaCloud,
      value: "300000000000000000", // 0.3 BNB
      chainId: 56,
      policyResults: [
        {
          policyId: "pol-hosting-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-hosting-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-hosting-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason:
            "value 0.3 BNB exceeds auto-approve threshold of 0.1 BNB — requires human approval",
        },
        { policyId: "pol-hosting-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(6),
    },

    // 1x confirmed: human-approved quarterly compute top-up 0.4 BNB
    {
      id: "tx-hosting-008",
      agentId: "agent-hosting-payer",
      status: "confirmed",
      toAddress: ADDR.elizaCloud,
      value: "400000000000000000", // 0.4 BNB
      chainId: 56,
      txHash: randomTxHash(),
      policyResults: [
        {
          policyId: "pol-hosting-spending",
          type: "spending-limit",
          passed: true,
        },
        {
          policyId: "pol-hosting-addresses",
          type: "approved-addresses",
          passed: true,
        },
        {
          policyId: "pol-hosting-auto",
          type: "auto-approve-threshold",
          passed: false,
          reason: "value 0.4 BNB exceeds auto-approve threshold of 0.1 BNB",
        },
        { policyId: "pol-hosting-rate", type: "rate-limit", passed: true },
      ],
      createdAt: hoursAgo(150), // ~6.25 days ago
      signedAt: hoursAgo(149.2),
      confirmedAt: hoursAgo(149),
    },
  ];

  await db.insert(transactions).values(txSeeds).onConflictDoNothing({ target: transactions.id });

  /* ════════════════════════════════════════════════════════════════════════ */
  /*  APPROVAL QUEUE                                                         */
  /* ════════════════════════════════════════════════════════════════════════ */

  const approvalSeeds: ApprovalSeed[] = [
    // treasury-ops: pending withdrawal
    {
      id: "appr-treasury-010",
      txId: "tx-treasury-010",
      agentId: "agent-treasury-ops",
      status: "pending",
      requestedAt: hoursAgo(2.9),
    },
    // treasury-ops: approved PancakeSwap swap (resolved)
    {
      id: "appr-treasury-006",
      txId: "tx-treasury-006",
      agentId: "agent-treasury-ops",
      status: "approved",
      requestedAt: hoursAgo(119.8),
      resolvedAt: hoursAgo(119.5),
      resolvedBy: TENANT_ID,
    },
    // treasury-ops: approved PancakeSwap swap (resolved)
    {
      id: "appr-treasury-007",
      txId: "tx-treasury-007",
      agentId: "agent-treasury-ops",
      status: "approved",
      requestedAt: hoursAgo(59.8),
      resolvedAt: hoursAgo(59.5),
      resolvedBy: TENANT_ID,
    },

    // dex-trader: pending large trade
    {
      id: "appr-dex-013",
      txId: "tx-dex-013",
      agentId: "agent-dex-trader",
      status: "pending",
      requestedAt: hoursAgo(1.9),
    },
    // dex-trader: approved larger swaps (resolved)
    {
      id: "appr-dex-009",
      txId: "tx-dex-009",
      agentId: "agent-dex-trader",
      status: "approved",
      requestedAt: hoursAgo(99.8),
      resolvedAt: hoursAgo(99.5),
      resolvedBy: TENANT_ID,
    },
    {
      id: "appr-dex-010",
      txId: "tx-dex-010",
      agentId: "agent-dex-trader",
      status: "approved",
      requestedAt: hoursAgo(55.8),
      resolvedAt: hoursAgo(55.5),
      resolvedBy: TENANT_ID,
    },

    // prediction-agent: pending 90 POL position
    {
      id: "appr-pred-009",
      txId: "tx-pred-009",
      agentId: "agent-prediction-agent",
      status: "pending",
      requestedAt: hoursAgo(3.9),
    },
    // prediction-agent: approved larger positions (resolved)
    {
      id: "appr-pred-006",
      txId: "tx-pred-006",
      agentId: "agent-prediction-agent",
      status: "approved",
      requestedAt: hoursAgo(69.8),
      resolvedAt: hoursAgo(69.2),
      resolvedBy: TENANT_ID,
    },
    {
      id: "appr-pred-007",
      txId: "tx-pred-007",
      agentId: "agent-prediction-agent",
      status: "approved",
      requestedAt: hoursAgo(29.8),
      resolvedAt: hoursAgo(29.5),
      resolvedBy: TENANT_ID,
    },

    // perp-trader: 2x pending positions
    {
      id: "appr-perp-017",
      txId: "tx-perp-017",
      agentId: "agent-perp-trader",
      status: "pending",
      requestedAt: hoursAgo(4.9),
    },
    {
      id: "appr-perp-018",
      txId: "tx-perp-018",
      agentId: "agent-perp-trader",
      status: "pending",
      requestedAt: hoursAgo(1.4),
    },
    // perp-trader: approved medium trades (resolved)
    {
      id: "appr-perp-011",
      txId: "tx-perp-011",
      agentId: "agent-perp-trader",
      status: "approved",
      requestedAt: hoursAgo(119.5),
      resolvedAt: hoursAgo(119.2),
      resolvedBy: TENANT_ID,
    },
    {
      id: "appr-perp-012",
      txId: "tx-perp-012",
      agentId: "agent-perp-trader",
      status: "approved",
      requestedAt: hoursAgo(67.8),
      resolvedAt: hoursAgo(67.5),
      resolvedBy: TENANT_ID,
    },
    {
      id: "appr-perp-013",
      txId: "tx-perp-013",
      agentId: "agent-perp-trader",
      status: "approved",
      requestedAt: hoursAgo(23.5),
      resolvedAt: hoursAgo(23.3),
      resolvedBy: TENANT_ID,
    },

    // hosting-payer: pending larger bill
    {
      id: "appr-hosting-007",
      txId: "tx-hosting-007",
      agentId: "agent-hosting-payer",
      status: "pending",
      requestedAt: hoursAgo(5.9),
    },
    // hosting-payer: approved quarterly top-up (resolved)
    {
      id: "appr-hosting-008",
      txId: "tx-hosting-008",
      agentId: "agent-hosting-payer",
      status: "approved",
      requestedAt: hoursAgo(149.5),
      resolvedAt: hoursAgo(149.2),
      resolvedBy: TENANT_ID,
    },
  ];

  await db
    .insert(approvalQueue)
    .values(approvalSeeds)
    .onConflictDoNothing({ target: approvalQueue.id });

  /* ── Summary ───────────────────────────────────────────────────────────── */
  console.log(`\nSeeded tenant: ${TENANT_ID}`);
  console.log(`Demo API key:  ${DEMO_API_KEY}`);
  console.log(`Agents:        ${agentDefs.length}`);
  console.log(`Policies:      ${policySeeds.length}`);
  console.log(`Transactions:  ${txSeeds.length}`);
  console.log(`Approvals:     ${approvalSeeds.length}`);
  console.log("\nAgent breakdown:");
  console.log("  treasury-ops       — 12 tx (BSC)");
  console.log("  dex-trader         — 15 tx (BSC + Base)");
  console.log("  prediction-agent   — 10 tx (Polygon)");
  console.log("  perp-trader        — 18 tx (Arbitrum)");
  console.log("  hosting-payer      —  8 tx (BSC)");
}

try {
  await seed();
} finally {
  await closeDb();
}
