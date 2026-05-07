#!/usr/bin/env bun
/**
 * Setup Script for Eliza Cloud
 *
 * Handles complete development environment setup with minimal configuration:
 * 1. Checks and creates .env.local with defaults
 * 2. Validates database connection
 * 3. Sets up x402 configuration
 *
 * Usage:
 *   bun run setup              # Full setup
 *   bun run setup --check      # Just validate current config
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { createPublicClient, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const ENV_FILE = ".env.local";
const EXAMPLE_ENV = ".env.example";

// ============================================================================
// Environment Helpers
// ============================================================================

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};

  const content = readFileSync(ENV_FILE, "utf-8");
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (key) {
      env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  }

  return env;
}

function updateEnvFile(key: string, value: string): void {
  let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";

  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trim() + `\n${key}=${value}\n`;
  }

  writeFileSync(ENV_FILE, content);
}

function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return false;

  return (
    value === "replace_with_strong_random_secret" ||
    value.includes("your-redis.upstash.io") ||
    value.includes("default:token@your-redis.upstash.io") ||
    value === "your_upstash_token_here" ||
    value === "your_readonly_token_here" ||
    value === "token" ||
    value === "unset"
  );
}

function ensureEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE) && existsSync(EXAMPLE_ENV)) {
    console.log("   Creating .env.local from example...");
    const example = readFileSync(EXAMPLE_ENV, "utf-8");
    writeFileSync(ENV_FILE, example);
  }

  return readEnvFile();
}

// ============================================================================
// Configuration Status
// ============================================================================

interface ConfigStatus {
  database: { configured: boolean; connected?: boolean; error?: string };
  auth: { configured: boolean; provider: string };
  payments: { stripe: boolean; x402: boolean };
  wallet: { configured: boolean; address?: string; balance?: string };
}

async function checkConfiguration(env: Record<string, string>): Promise<ConfigStatus> {
  const status: ConfigStatus = {
    database: { configured: false },
    auth: { configured: false, provider: "steward" },
    payments: { stripe: false, x402: false },
    wallet: { configured: false },
  };

  // Database
  if (env.DATABASE_URL) {
    status.database.configured = true;
  }

  // Auth (Steward)
  if (
    env.NEXT_PUBLIC_STEWARD_API_URL &&
    env.STEWARD_SESSION_SECRET &&
    !isPlaceholderValue(env.NEXT_PUBLIC_STEWARD_API_URL) &&
    !isPlaceholderValue(env.STEWARD_SESSION_SECRET)
  ) {
    status.auth.configured = true;
  }

  // Stripe
  if (env.STRIPE_SECRET_KEY && env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    status.payments.stripe = true;
  }

  // x402
  if (env.ENABLE_X402_PAYMENTS === "true" && env.X402_RECIPIENT_ADDRESS) {
    status.payments.x402 = true;
  }

  // Wallet
  const privateKey = env.DEPLOYER_PRIVATE_KEY;
  if (privateKey) {
    status.wallet.configured = true;
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    status.wallet.address = account.address;

    // Check balance
    const network = env.X402_NETWORK || "base-sepolia";
    const chain = network === "base" ? base : baseSepolia;
    const rpcUrl = network === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org";

    try {
      const client = createPublicClient({ chain, transport: http(rpcUrl) });
      const balance = await client.getBalance({ address: account.address });
      status.wallet.balance = formatUnits(balance, 18);
    } catch {
      status.wallet.balance = "unknown";
    }
  }

  return status;
}

// ============================================================================
// Display Functions
// ============================================================================

function displayStatus(status: ConfigStatus): void {
  console.log("\n📊 Configuration Status");
  console.log("========================");

  // Database
  const dbIcon = status.database.configured ? "✅" : "❌";
  console.log(
    `${dbIcon} Database: ${status.database.configured ? "Configured" : "Not configured"}`,
  );

  // Auth
  const authIcon = status.auth.configured ? "✅" : "❌";
  console.log(
    `${authIcon} Auth (${status.auth.provider}): ${status.auth.configured ? "Configured" : "Not configured"}`,
  );

  // Payments
  const stripeIcon = status.payments.stripe ? "✅" : "⬜";
  const x402Icon = status.payments.x402 ? "✅" : "⬜";
  console.log(`${stripeIcon} Stripe: ${status.payments.stripe ? "Configured" : "Optional"}`);
  console.log(`${x402Icon} x402 Crypto: ${status.payments.x402 ? "Enabled" : "Disabled"}`);

  // Wallet
  if (status.wallet.configured) {
    console.log(`✅ Wallet: ${status.wallet.address?.slice(0, 10)}...`);
    console.log(`   └── Balance: ${status.wallet.balance} ETH`);
  } else {
    console.log(`⬜ Wallet: Not configured (needed for deployments)`);
  }
}

// ============================================================================
// Setup Steps
// ============================================================================

async function setupDefaults(env: Record<string, string>): Promise<void> {
  console.log("\n⚙️  Setting up defaults...");

  const defaults: Record<string, string> = {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_API_URL: "http://localhost:3000",
    X402_NETWORK: "base-sepolia",
    CACHE_ENABLED: "true",
    CACHE_BACKEND: "wadis",
    NEXT_PUBLIC_CREDITS_SSE_ENABLED: "true",
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!env[key] || isPlaceholderValue(env[key])) {
      updateEnvFile(key, value);
      console.log(`   Set ${key}=${value}`);
    }
  }
}

async function promptForMissing(env: Record<string, string>): Promise<void> {
  // DATABASE_URL is intentionally not required: local dev falls back to
  // embedded PGlite at .eliza/.pgdata. Cloud deployments set it to a Neon URL.
  const required = [
    {
      key: "NEXT_PUBLIC_STEWARD_API_URL",
      hint: "Steward API base URL (e.g. http://localhost:8787/steward)",
    },
    {
      key: "STEWARD_SESSION_SECRET",
      hint: "HS256 secret used by Steward to sign session JWTs (must match Steward host)",
    },
  ];

  const missing = required.filter((r) => !env[r.key] || isPlaceholderValue(env[r.key]));

  if (missing.length > 0) {
    console.log("\n⚠️  Required configuration missing:");
    for (const m of missing) {
      console.log(`   ${m.key} - ${m.hint}`);
    }
    console.log("\n   Edit .env.local to add these values, then run setup again.");
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║              Eliza Cloud Setup                           ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");

  // Step 1: Ensure .env.local exists
  console.log("\n📁 Environment File");
  console.log("====================");
  let env = ensureEnvFile();
  console.log(`   Using: ${ENV_FILE}`);

  // Step 2: Set defaults
  if (!checkOnly) {
    await setupDefaults(env);
    env = readEnvFile(); // Re-read after updates
  }

  // Step 3: Check configuration
  const status = await checkConfiguration(env);
  displayStatus(status);

  // Step 4: Show what's missing
  await promptForMissing(env);

  // Summary
  console.log("\n🚀 Next Steps");
  console.log("==============");

  const missingRequired = !status.database.configured || !status.auth.configured;

  if (missingRequired) {
    console.log("   1. Add required configuration to .env.local");
    console.log("   2. Run: bun run setup --check");
    console.log("   3. Run: bun run dev");
  } else {
    console.log("   ✅ Ready! Run: bun run dev");
  }
}

main().catch(console.error);
