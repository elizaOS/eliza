/**
 * Development Credentials Utility
 *
 * @description Generates and manages development credentials for local testing.
 * In development mode, creates deterministic admin credentials that are logged
 * at startup for easy authentication. These credentials are NEVER used in production.
 *
 * Security Notes:
 * - Only active when NODE_ENV !== 'production'
 * - Uses deterministic derivation so credentials are consistent across restarts
 * - Credentials are printed to console for developer convenience
 * - In production, this module is essentially a no-op
 */

import { createHash } from "node:crypto";
import { logger } from "@polyagent/shared";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Hardhat account #0 - standard development wallet
 * This is a well-known test private key from Hardhat's default accounts
 */
const HARDHAT_DEV_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_DEV_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Dev admin user ID - consistent across sessions
 */
const DEV_ADMIN_USER_ID = "dev-admin-local";

/**
 * Development credentials structure
 */
export interface DevCredentials {
  /** Whether dev mode is active */
  isDevMode: boolean;
  /** Dev admin user ID */
  adminUserId: string;
  /** Dev admin wallet address */
  walletAddress: string;
  /** Dev admin private key (for wallet signing) */
  privateKey: string;
  /** Dev admin token for direct API auth */
  devAdminToken: string;
  /** Dev cron secret */
  cronSecret: string;
  /** Dev agent secret (separate from cron) */
  agentSecret: string;
}

/**
 * Generate deterministic dev secrets based on a seed
 * Uses SHA-256 hash for deterministic but non-reversible derivation
 */
function deriveSecret(seed: string, purpose: string): string {
  const hash = createHash("sha256")
    .update(`polyagent-dev:${seed}:${purpose}`)
    .digest("hex");
  return `dev_${purpose}_${hash.substring(0, 32)}`;
}

/**
 * Get development credentials
 * Returns credentials only in development mode
 */
export function getDevCredentials(): DevCredentials | null {
  if (!isDevelopment) {
    return null;
  }

  // Use the machine hostname or a fixed seed for consistency
  const seed = process.env.HOSTNAME || "localhost";

  return {
    isDevMode: true,
    adminUserId: DEV_ADMIN_USER_ID,
    walletAddress: HARDHAT_DEV_ADDRESS,
    privateKey: HARDHAT_DEV_PRIVATE_KEY,
    devAdminToken: deriveSecret(seed, "admin"),
    cronSecret: deriveSecret(seed, "cron"),
    agentSecret: deriveSecret(seed, "agent"),
  };
}

/**
 * Check if a token matches the dev admin token
 */
export function isValidDevAdminToken(token: string): boolean {
  if (!isDevelopment) {
    return false;
  }

  const creds = getDevCredentials();
  if (!creds) {
    return false;
  }

  return token === creds.devAdminToken;
}

/**
 * Get the dev admin user info for authenticated sessions
 */
export function getDevAdminUser(): {
  userId: string;
  dbUserId: string;
  walletAddress: string;
} | null {
  if (!isDevelopment) {
    return null;
  }

  const creds = getDevCredentials();
  if (!creds) {
    return null;
  }

  return {
    userId: creds.adminUserId,
    dbUserId: creds.adminUserId,
    walletAddress: creds.walletAddress,
  };
}

/**
 * Check if a cron secret is valid (supports both env and dev credentials)
 */
export function isValidCronSecret(secret: string): boolean {
  // First check environment variable
  const envSecret = process.env.CRON_SECRET;
  if (envSecret && secret === envSecret) {
    return true;
  }

  // In dev mode, also accept dev cron secret
  if (isDevelopment) {
    const creds = getDevCredentials();
    if (creds && secret === creds.cronSecret) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an agent secret is valid (supports both env and dev credentials)
 */
export function isValidAgentSecret(secret: string): boolean {
  // First check environment variable (use separate AGENT_SECRET, fallback to CRON_SECRET)
  const envSecret = process.env.AGENT_SECRET || process.env.CRON_SECRET;
  if (envSecret && secret === envSecret) {
    return true;
  }

  // In dev mode, also accept dev agent secret
  if (isDevelopment) {
    const creds = getDevCredentials();
    if (creds && secret === creds.agentSecret) {
      return true;
    }
  }

  return false;
}

// Track if we've logged credentials this session
let hasLoggedCredentials = false;

/**
 * Log development credentials to console (only once per session)
 * Call this at server startup
 */
export function logDevCredentials(): void {
  if (!isDevelopment || hasLoggedCredentials) {
    return;
  }

  const creds = getDevCredentials();
  if (!creds) {
    return;
  }

  hasLoggedCredentials = true;

  const banner = `
╔════════════════════════════════════════════════════════════════════════════╗
║                       🔧 DEVELOPMENT MODE ACTIVE 🔧                        ║
╠════════════════════════════════════════════════════════════════════════════╣
║  Dev Admin Credentials (for local testing only):                           ║
║                                                                            ║
║  Wallet Address:  ${creds.walletAddress}                 ║
║  Private Key:     ${creds.privateKey.substring(0, 20)}...                                ║
║  Dev Admin Token: ${creds.devAdminToken}                           ║
║                                                                            ║
║  Use these headers for admin API access:                                   ║
║    x-dev-admin-token: ${creds.devAdminToken}                       ║
║                                                                            ║
║  Cron Secret:     ${creds.cronSecret}                              ║
║  Agent Secret:    ${creds.agentSecret}                             ║
║                                                                            ║
║  ⚠️  These credentials are ONLY valid in development mode!                 ║
╚════════════════════════════════════════════════════════════════════════════╝
`;

  // Use direct console.log to ensure this is visible
  console.log(banner);

  // Also log via logger for structured logs
  logger.info(
    "Development credentials initialized",
    {
      walletAddress: creds.walletAddress,
      adminUserId: creds.adminUserId,
    },
    "DevCredentials",
  );
}
