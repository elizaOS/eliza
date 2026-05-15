/**
 * Twitter/X verification for whitelist eligibility.
 *
 * Users post a verification message on X containing their agent name and
 * wallet address. The app verifies the tweet exists using the FxTwitter API
 * (free, no auth required). Verified addresses are stored locally and can
 * be collected into a Merkle tree for on-chain whitelist proofs.
 */

import fs from "node:fs";
import path from "node:path";
import {
  createIntegrationTelemetrySpan,
  resolveStateDir,
} from "@elizaos/agent";
import { logger } from "@elizaos/core";

export interface VerificationResult {
  verified: boolean;
  error: string | null;
  handle: string | null;
}

const WHITELIST_FILE = "whitelist.json";

// ── Types ────────────────────────────────────────────────────────────────

interface WhitelistEntry {
  timestamp: string;
  tweetUrl: string;
  handle: string;
}

interface WhitelistData {
  verified: Record<string, WhitelistEntry>;
}

// ── Verification Message ─────────────────────────────────────────────────

export function generateVerificationMessage(
  agentName: string,
  walletAddress: string,
): string {
  const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  return `Verifying my Eliza agent "${agentName}" | ${shortAddr} #ElizaAgent`;
}

// ── Tweet Verification ───────────────────────────────────────────────────

function parseTweetUrl(
  url: string,
): { screenName: string; tweetId: string } | null {
  const match = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
  if (!match) return null;
  return { screenName: match[1], tweetId: match[2] };
}

export async function verifyTweet(
  tweetUrl: string,
  walletAddress: string,
): Promise<VerificationResult> {
  const parsed = parseTweetUrl(tweetUrl);
  if (!parsed) {
    return {
      verified: false,
      error: "Invalid tweet URL. Use a twitter.com or x.com status URL.",
      handle: null,
    };
  }

  const apiUrl = `https://api.fxtwitter.com/${parsed.screenName}/status/${parsed.tweetId}`;

  const verifySpan = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation: "verify_tweet",
    timeoutMs: 15_000,
  });

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      headers: { "User-Agent": "ElizaVerifier/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    verifySpan.failure({ error: err });
    logger.warn(`[twitter-verify] FxTwitter fetch failed: ${err}`);
    return {
      verified: false,
      error: "Could not reach tweet verification service. Try again later.",
      handle: null,
    };
  }

  if (!response.ok) {
    if (response.status === 404) {
      verifySpan.success({ statusCode: 404 });
      return {
        verified: false,
        error:
          "Tweet not found. Make sure the URL is correct and the tweet is public.",
        handle: null,
      };
    }
    verifySpan.failure({
      statusCode: response.status,
      errorKind: "http_error",
    });
    return {
      verified: false,
      error: `Tweet fetch failed (HTTP ${response.status})`,
      handle: null,
    };
  }

  let data: {
    code?: number;
    tweet?: {
      text?: string;
      author?: { screen_name?: string };
    };
  };

  try {
    data = (await response.json()) as typeof data;
  } catch (err) {
    verifySpan.failure({ error: err, statusCode: response.status });
    return {
      verified: false,
      error: "Invalid response from verification service",
      handle: null,
    };
  }

  if (!data.tweet?.text) {
    verifySpan.failure({
      statusCode: response.status,
      errorKind: "empty_content",
    });
    return {
      verified: false,
      error: "Could not read tweet content",
      handle: null,
    };
  }

  const tweetText = data.tweet.text;
  const handle = data.tweet.author?.screen_name ?? parsed.screenName;

  const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  const hasAddress =
    tweetText.includes(shortAddr) ||
    tweetText.toLowerCase().includes(walletAddress.toLowerCase().slice(0, 10));
  const hasHashtag = tweetText.includes("#ElizaAgent");

  if (!hasAddress) {
    return {
      verified: false,
      error:
        "Tweet does not contain your wallet address. Make sure you copied the full verification message.",
      handle,
    };
  }
  if (!hasHashtag) {
    return {
      verified: false,
      error: "Tweet is missing #ElizaAgent hashtag.",
      handle,
    };
  }

  verifySpan.success({ statusCode: response.status });
  return { verified: true, error: null, handle };
}

// ── Whitelist Storage ────────────────────────────────────────────────────

function whitelistPath(): string {
  return path.join(resolveStateDir(), WHITELIST_FILE);
}

export function loadWhitelist(): WhitelistData {
  const filePath = whitelistPath();
  if (!fs.existsSync(filePath)) return { verified: {} };
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as WhitelistData;
  } catch {
    logger.warn(
      `[twitter-verify] Corrupt whitelist file, resetting: ${filePath}`,
    );
    return { verified: {} };
  }
}

function saveWhitelist(data: WhitelistData): void {
  const filePath = whitelistPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function markAddressVerified(
  address: string,
  tweetUrl: string,
  handle: string,
): void {
  const wl = loadWhitelist();
  wl.verified[address.toLowerCase()] = {
    timestamp: new Date().toISOString(),
    tweetUrl,
    handle,
  };
  saveWhitelist(wl);
  logger.info(`[twitter-verify] Address ${address} verified via @${handle}`);
}

export function isAddressWhitelisted(address: string): boolean {
  const wl = loadWhitelist();
  return address.toLowerCase() in wl.verified;
}

export function getVerifiedAddresses(): string[] {
  const wl = loadWhitelist();
  return Object.keys(wl.verified);
}
