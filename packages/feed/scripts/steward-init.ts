#!/usr/bin/env bun
/**
 * One-time tenant provisioning script for Steward.
 *
 * Run this once after first-booting Steward to create the "feed" tenant
 * and obtain the API key. Copy the output into .env.
 *
 * Usage:
 *   bun run steward:init
 *   bun run steward:init -- --api-url http://my-steward-host:3200
 *
 * Prerequisites:
 *   - Steward is running (bun run dev starts it via pre-dev)
 *   - STEWARD_PLATFORM_KEYS is set in .env (or pass via env)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env for STEWARD_API_URL and STEWARD_PLATFORM_KEYS
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

// Allow --api-url flag override
const apiUrlFlag = process.argv.indexOf("--api-url");
const STEWARD_API_URL =
  apiUrlFlag !== -1 && process.argv[apiUrlFlag + 1]
    ? process.argv[apiUrlFlag + 1]
    : (process.env.STEWARD_API_URL ?? "http://localhost:3200");

const PLATFORM_KEY_RAW = process.env.STEWARD_PLATFORM_KEYS ?? "";
const PLATFORM_KEY = PLATFORM_KEY_RAW.split(",")[0].trim();

if (!PLATFORM_KEY) {
  console.error("❌ STEWARD_PLATFORM_KEYS is required.");
  console.error("   Add it to .env: STEWARD_PLATFORM_KEYS=<your-key>");
  console.error("   Generate one: openssl rand -hex 32");
  process.exit(1);
}

console.info(`Provisioning feed tenant on ${STEWARD_API_URL}...`);

// Check Steward is reachable
const healthOk = await fetch(`${STEWARD_API_URL}/health`)
  .then((r) => r.ok)
  .catch(() => false);

if (!healthOk) {
  console.error(`❌ Steward is not reachable at ${STEWARD_API_URL}`);
  console.error(
    "   Make sure it is running: bun run dev (or docker compose up steward)",
  );
  process.exit(1);
}

const res = await fetch(`${STEWARD_API_URL}/platform/tenants`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Steward-Platform-Key": PLATFORM_KEY,
  },
  body: JSON.stringify({ id: "feed", name: "Feed Social" }),
});

const data = (await res.json()) as {
  ok: boolean;
  apiKey?: string;
  data?: { apiKey?: string };
  error?: string;
};

if (res.status === 409) {
  console.info('ℹ️  Tenant "feed" already exists in Steward.');
  console.info("   The API key is not re-returned for security.");
  console.info(
    "   If you lost the key, check your existing .env for STEWARD_TENANT_API_KEY.",
  );
  process.exit(0);
}

if (!res.ok || !data.ok) {
  console.error("❌ Failed to create tenant:", data.error ?? res.statusText);
  process.exit(1);
}

const apiKey = data.apiKey ?? data.data?.apiKey ?? "";

console.info("\n✅ Feed tenant provisioned. Add these to .env:\n");
console.info(`STEWARD_TENANT_ID=feed`);
console.info(`STEWARD_TENANT_API_KEY=${apiKey}`);
console.info("\n⚠️  Keep the API key secret — it grants full tenant access.");
