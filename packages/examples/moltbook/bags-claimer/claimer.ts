#!/usr/bin/env bun

/**
 * Bags Fee Claimer - Automatically claims fees from Bags
 *
 * Usage:
 *   bun run claimer.ts          # Run continuously (hourly)
 *   bun run claimer.ts --once   # Run once and exit
 *
 * Credentials: ~/.config/bags/credentials.json
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// ============================================================================
// Configuration
// ============================================================================

const BAGS_API_BASE = "https://public-api-v2.bags.fm/api/v1";
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const CREDENTIALS_PATH = path.join(homedir(), ".config/bags/credentials.json");
const CLAIM_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_CLAIMABLE_LAMPORTS = 1_000_000; // 0.001 SOL minimum

const RUN_ONCE = process.argv.includes("--once");

interface BagsCredentials {
  jwt_token: string;
  api_key: string;
  moltbook_username: string;
  wallets: string[];
}

interface ClaimablePosition {
  baseMint: string;
  totalClaimableLamportsUserShare: number;
  user: string;
}

interface ClaimTxResponse {
  tx: string;
  blockhash: { blockhash: string; lastValidBlockHeight: number };
}

// ============================================================================
// Utility Functions
// ============================================================================

function loadCredentials(): BagsCredentials {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Credentials not found at ${CREDENTIALS_PATH}`);
  }
  return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as BagsCredentials;
}

function formatSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(4);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ============================================================================
// API Functions
// ============================================================================

async function getClaimablePositions(
  wallet: string,
  apiKey: string,
): Promise<ClaimablePosition[]> {
  const res = await fetch(
    `${BAGS_API_BASE}/token-launch/claimable-positions?wallet=${wallet}`,
    {
      headers: { "x-api-key": apiKey },
    },
  );
  if (!res.ok) throw new Error(`Failed to get positions: ${res.status}`);
  const data = await res.json();
  return (data.response || []) as ClaimablePosition[];
}

async function generateClaimTx(
  wallet: string,
  tokenMint: string,
  apiKey: string,
): Promise<ClaimTxResponse[]> {
  const res = await fetch(`${BAGS_API_BASE}/token-launch/claim-txs/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ feeClaimer: wallet, tokenMint }),
  });
  if (!res.ok) throw new Error(`Failed to generate tx: ${res.status}`);
  const data = await res.json();
  return (data.response || []) as ClaimTxResponse[];
}

async function exportPrivateKey(
  jwtToken: string,
  walletAddress: string,
): Promise<string> {
  const res = await fetch(`${BAGS_API_BASE}/agent/wallet/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: jwtToken, walletAddress }),
  });
  if (!res.ok) throw new Error(`Failed to export key: ${res.status}`);
  const data = await res.json();
  return data.response.privateKey as string;
}

// ============================================================================
// Transaction Functions
// ============================================================================

async function signAndSendTx(
  txBase58: string,
  privateKeyBase58: string,
): Promise<string> {
  const connection = new Connection(SOLANA_RPC, "confirmed");

  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);

  const txBytes = bs58.decode(txBase58);
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([keypair]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    signature,
    "confirmed",
  );

  if (confirmation.value.err) {
    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  }
  return signature;
}

// ============================================================================
// Main Logic
// ============================================================================

async function claimAllFees(
  creds: BagsCredentials,
): Promise<{ claimed: number; tokens: string[]; sigs: string[] }> {
  const results = { claimed: 0, tokens: [] as string[], sigs: [] as string[] };

  for (const wallet of creds.wallets) {
    log(`Checking wallet: ${wallet}`);

    const positions = await getClaimablePositions(wallet, creds.api_key);
    const claimable = positions.filter(
      (p) => p.totalClaimableLamportsUserShare >= MIN_CLAIMABLE_LAMPORTS,
    );

    if (claimable.length === 0) {
      log(`No claimable fees above ${formatSol(MIN_CLAIMABLE_LAMPORTS)} SOL`);
      continue;
    }

    let privateKey: string | null = null;

    for (const pos of claimable) {
      const amount = formatSol(pos.totalClaimableLamportsUserShare);
      log(`Found ${amount} SOL for token ${pos.baseMint.slice(0, 8)}...`);

      try {
        const txs = await generateClaimTx(wallet, pos.baseMint, creds.api_key);
        if (txs.length === 0) {
          log(`  No transactions generated`);
          continue;
        }

        if (!privateKey) {
          log("  Exporting private key...");
          privateKey = await exportPrivateKey(creds.jwt_token, wallet);
        }

        for (const tx of txs) {
          log("  Signing and sending...");
          const sig = await signAndSendTx(tx.tx, privateKey);
          log(`  ✅ Claimed! https://solscan.io/tx/${sig}`);
          results.claimed += pos.totalClaimableLamportsUserShare;
          results.tokens.push(pos.baseMint);
          results.sigs.push(sig);
        }
      } catch (err) {
        log(`  ❌ Failed: ${err}`);
      }
    }
  }
  return results;
}

async function runCycle(): Promise<void> {
  try {
    const creds = loadCredentials();
    log(`=== Claim cycle for ${creds.moltbook_username} ===`);

    const results = await claimAllFees(creds);

    if (results.claimed > 0) {
      log(
        `\n🎉 Claimed ${formatSol(results.claimed)} SOL from ${results.tokens.length} token(s)`,
      );
      for (const sig of results.sigs) {
        log(`   https://solscan.io/tx/${sig}`);
      }
    } else {
      log("No fees to claim this cycle");
    }
  } catch (err) {
    log(`❌ Cycle failed: ${err}`);
  }
}

async function main(): Promise<void> {
  console.log("");
  console.log(
    "╔════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║              💰 BAGS FEE CLAIMER - Auto Harvest 💰             ║",
  );
  console.log(
    "╚════════════════════════════════════════════════════════════════╝",
  );
  console.log("");

  if (!existsSync(CREDENTIALS_PATH)) {
    console.log("❌ No credentials found at ~/.config/bags/credentials.json");
    console.log("   Authenticate with Bags first via Moltbook.");
    process.exit(1);
  }

  const creds = loadCredentials();
  console.log(`Agent:    ${creds.moltbook_username}`);
  console.log(`Wallets:  ${creds.wallets.join(", ")}`);
  console.log(
    `Mode:     ${RUN_ONCE ? "Single run" : `Continuous (every ${CLAIM_INTERVAL_MS / 1000 / 60} min)`}`,
  );
  console.log(`Min:      ${formatSol(MIN_CLAIMABLE_LAMPORTS)} SOL`);
  console.log("");

  // Run immediately
  await runCycle();

  if (RUN_ONCE) {
    console.log("\n✨ Done!");
    process.exit(0);
  }

  console.log("\nRunning continuously. Press Ctrl+C to stop.\n");

  // Schedule hourly
  setInterval(runCycle, CLAIM_INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\nShutting down... May your bags be full 💰");
    process.exit(0);
  });

  process.on("SIGTERM", () => process.exit(0));

  await new Promise(() => {});
}

main().catch(console.error);
