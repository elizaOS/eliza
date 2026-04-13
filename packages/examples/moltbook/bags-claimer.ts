#!/usr/bin/env bun

/**
 * Bags Fee Claimer - Automatically claims fees from Bags every hour
 *
 * Usage:
 *   bun run bags-claimer.ts
 *
 * Requires credentials at ~/.config/bags/credentials.json:
 * {
 *   "jwt_token": "your_jwt_token",
 *   "api_key": "your_api_key",
 *   "moltbook_username": "your_username",
 *   "wallets": ["wallet_address"]
 * }
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
const MIN_CLAIMABLE_LAMPORTS = 1_000_000; // 0.001 SOL minimum to trigger claim

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
  isMigrated: boolean;
}

interface ClaimTxResponse {
  tx: string;
  blockhash: {
    blockhash: string;
    lastValidBlockHeight: number;
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function loadCredentials(): BagsCredentials {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Credentials not found at ${CREDENTIALS_PATH}. Run Bags authentication first.`,
    );
  }
  const content = readFileSync(CREDENTIALS_PATH, "utf-8");
  return JSON.parse(content) as BagsCredentials;
}

function formatSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(4);
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// ============================================================================
// Bags API Functions
// ============================================================================

async function getClaimablePositions(
  wallet: string,
  apiKey: string,
): Promise<ClaimablePosition[]> {
  const response = await fetch(
    `${BAGS_API_BASE}/token-launch/claimable-positions?wallet=${wallet}`,
    {
      headers: { "x-api-key": apiKey },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to get claimable positions: ${response.status}`);
  }

  const data = await response.json();
  return (data.response || []) as ClaimablePosition[];
}

async function generateClaimTx(
  wallet: string,
  tokenMint: string,
  apiKey: string,
): Promise<ClaimTxResponse[]> {
  const response = await fetch(`${BAGS_API_BASE}/token-launch/claim-txs/v3`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      feeClaimer: wallet,
      tokenMint: tokenMint,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to generate claim tx: ${response.status} - ${text}`,
    );
  }

  const data = await response.json();
  return (data.response || []) as ClaimTxResponse[];
}

async function exportPrivateKey(
  jwtToken: string,
  walletAddress: string,
): Promise<string> {
  const response = await fetch(`${BAGS_API_BASE}/agent/wallet/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: jwtToken,
      walletAddress: walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to export private key: ${response.status}`);
  }

  const data = await response.json();
  return data.response.privateKey as string;
}

// ============================================================================
// Transaction Functions
// ============================================================================

async function signAndSendTransaction(
  txBase58: string,
  privateKeyBase58: string,
): Promise<string> {
  const connection = new Connection(SOLANA_RPC, "confirmed");

  // Decode private key and create keypair
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);

  // Decode and sign transaction
  const txBytes = bs58.decode(txBase58);
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([keypair]);

  // Send transaction
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Wait for confirmation
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
// Main Claim Logic
// ============================================================================

async function claimAllFees(credentials: BagsCredentials): Promise<{
  claimed: number;
  tokens: string[];
  signatures: string[];
}> {
  const results = {
    claimed: 0,
    tokens: [] as string[],
    signatures: [] as string[],
  };

  for (const wallet of credentials.wallets) {
    log(`Checking claimable fees for wallet: ${wallet}`);

    // Get all claimable positions
    const positions = await getClaimablePositions(wallet, credentials.api_key);

    // Filter positions with meaningful amounts
    const claimablePositions = positions.filter(
      (p) => p.totalClaimableLamportsUserShare >= MIN_CLAIMABLE_LAMPORTS,
    );

    if (claimablePositions.length === 0) {
      log(
        `No claimable fees above minimum threshold (${formatSol(MIN_CLAIMABLE_LAMPORTS)} SOL)`,
      );
      continue;
    }

    // Get private key for signing (only once per wallet)
    let privateKey: string | null = null;

    for (const position of claimablePositions) {
      const amount = formatSol(position.totalClaimableLamportsUserShare);
      log(`Found ${amount} SOL claimable for token ${position.baseMint}`);

      try {
        // Generate claim transaction
        const claimTxs = await generateClaimTx(
          wallet,
          position.baseMint,
          credentials.api_key,
        );

        if (claimTxs.length === 0) {
          log(`No claim transactions generated for ${position.baseMint}`);
          continue;
        }

        // Export private key if not already done
        if (!privateKey) {
          log("Exporting wallet private key for signing...");
          privateKey = await exportPrivateKey(credentials.jwt_token, wallet);
        }

        // Sign and send each transaction
        for (const claimTx of claimTxs) {
          log(`Signing and sending claim transaction...`);
          const signature = await signAndSendTransaction(
            claimTx.tx,
            privateKey,
          );

          log(`✅ Claimed! Signature: ${signature}`);
          log(`   https://solscan.io/tx/${signature}`);

          results.claimed += position.totalClaimableLamportsUserShare;
          results.tokens.push(position.baseMint);
          results.signatures.push(signature);
        }
      } catch (error) {
        log(`❌ Failed to claim for ${position.baseMint}: ${error}`);
      }
    }
  }

  return results;
}

// ============================================================================
// Main Loop
// ============================================================================

async function runClaimCycle(): Promise<void> {
  try {
    const credentials = loadCredentials();
    log(`Starting claim cycle for ${credentials.moltbook_username}`);
    log(`Wallets: ${credentials.wallets.join(", ")}`);

    const results = await claimAllFees(credentials);

    if (results.claimed > 0) {
      log(`\n🎉 Claim cycle complete!`);
      log(`   Total claimed: ${formatSol(results.claimed)} SOL`);
      log(`   Tokens: ${results.tokens.length}`);
      log(`   Transactions: ${results.signatures.length}`);
    } else {
      log(`Claim cycle complete - no fees to claim`);
    }
  } catch (error) {
    log(`❌ Claim cycle failed: ${error}`);
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
    "╠════════════════════════════════════════════════════════════════╣",
  );
  console.log(
    "║  Automatically claims earned fees from Bags every hour         ║",
  );
  console.log(
    "║  Credentials: ~/.config/bags/credentials.json                  ║",
  );
  console.log(
    "╚════════════════════════════════════════════════════════════════╝",
  );
  console.log("");

  // Verify credentials exist
  if (!existsSync(CREDENTIALS_PATH)) {
    console.log("❌ No Bags credentials found!");
    console.log("");
    console.log("To authenticate with Bags:");
    console.log("  1. Run the Bags authentication flow via Moltbook");
    console.log("  2. Save credentials to ~/.config/bags/credentials.json");
    console.log("");
    process.exit(1);
  }

  const credentials = loadCredentials();
  console.log(`Agent: ${credentials.moltbook_username}`);
  console.log(`Wallets: ${credentials.wallets.length}`);
  console.log(`Interval: ${CLAIM_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`Min claim: ${formatSol(MIN_CLAIMABLE_LAMPORTS)} SOL`);
  console.log("");
  console.log("Press Ctrl+C to stop");
  console.log("");
  console.log("═".repeat(68));
  console.log("");

  // Run immediately on start
  await runClaimCycle();

  // Then run every hour
  setInterval(async () => {
    console.log("");
    console.log("═".repeat(68));
    console.log("");
    await runClaimCycle();
  }, CLAIM_INTERVAL_MS);

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("");
    console.log("Shutting down Bags Fee Claimer...");
    console.log("May your bags be ever full. 💰");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch(console.error);
