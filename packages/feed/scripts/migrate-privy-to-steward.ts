#!/usr/bin/env bun
/**
 * Privy → Steward user migration script.
 *
 * Phase A: Export all users from Privy Admin API (paginated)
 * Phase B: Pre-seed email-having users in Steward via POST /platform/users
 * Phase C: Write manifest of email-less users (linked by social at runtime)
 *
 * Usage:
 *   bun run scripts/migrate-privy-to-steward.ts --dry-run   # report only, no writes
 *   bun run scripts/migrate-privy-to-steward.ts             # actually migrate
 *
 * Required env vars:
 *   NEXT_PUBLIC_PRIVY_APP_ID   — Privy app ID (from Privy dashboard)
 *   PRIVY_APP_SECRET           — Privy app secret (from Privy dashboard)
 *   STEWARD_API_URL            — Steward API URL (default: http://localhost:3200)
 *   STEWARD_PLATFORM_KEYS      — Steward platform key (comma-separated)
 *
 * Outputs:
 *   migrations/privy-emailless-users.json   — manifest of social-only users
 *
 * Notes:
 *   - Idempotent: re-running will not duplicate users (Steward returns isNew=false)
 *   - Email-less users are NOT pre-seeded; they are linked at login time via
 *     social profile matching in auth-middleware.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Load .env ────────────────────────────────────────────────────────────────

const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
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

// ─── Config ───────────────────────────────────────────────────────────────────

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET ?? "";
const STEWARD_API_URL = process.env.STEWARD_API_URL ?? "http://localhost:3200";
const PLATFORM_KEY = (process.env.STEWARD_PLATFORM_KEYS ?? "")
  .split(",")[0]
  .trim();
const DRY_RUN = process.argv.includes("--dry-run");

if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
  console.error(
    "❌ NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET are required.",
  );
  console.error("   Find them in your Privy dashboard → Settings → API Keys.");
  process.exit(1);
}
if (!PLATFORM_KEY) {
  console.error("❌ STEWARD_PLATFORM_KEYS is required.");
  process.exit(1);
}

if (DRY_RUN) {
  console.info("🔍 DRY RUN — no writes will be made to Steward or disk.");
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PrivyLinkedAccount {
  type: string;
  address?: string;
  email?: string;
}

interface PrivyUser {
  id: string; // did:privy:xxx
  linked_accounts: PrivyLinkedAccount[];
  created_at: number;
}

interface EmaillessUser {
  privyId: string;
  farcasterFid: number | null;
  farcasterUsername: string | null;
  twitterUsername: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
}

// ─── Phase A: Export Privy users ─────────────────────────────────────────────

const basicAuth = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString(
  "base64",
);

console.info("\n📥 Phase A: Exporting users from Privy Admin API...");

const allPrivyUsers: PrivyUser[] = [];
let cursor: string | undefined;

do {
  const url = new URL("https://auth.privy.io/api/v1/users");
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "privy-app-id": PRIVY_APP_ID,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ Privy API error: ${res.status} ${text}`);
    process.exit(1);
  }

  const body = (await res.json()) as {
    data: PrivyUser[];
    next_cursor?: string;
  };

  allPrivyUsers.push(...body.data);
  cursor = body.next_cursor;
  process.stdout.write(`\r   Fetched ${allPrivyUsers.length} users...`);
} while (cursor);

console.info(`\n✅ Exported ${allPrivyUsers.length} Privy users`);

// ─── Extract email and social data ────────────────────────────────────────────

function getUserEmail(user: PrivyUser): string | null {
  const emailAccount = user.linked_accounts.find((a) => a.type === "email");
  return emailAccount?.email ?? null;
}

function getFarcasterFid(user: PrivyUser): number | null {
  const fc = user.linked_accounts.find((a) => a.type === "farcaster");
  return fc ? Number((fc as { fid?: number }).fid ?? 0) || null : null;
}
function getFarcasterUsername(user: PrivyUser): string | null {
  const fc = user.linked_accounts.find((a) => a.type === "farcaster");
  return fc
    ? String((fc as { username?: string }).username ?? "") || null
    : null;
}
function getTwitterUsername(user: PrivyUser): string | null {
  const tw = user.linked_accounts.find((a) => a.type === "twitter_oauth");
  return tw
    ? String((tw as { username?: string }).username ?? "") || null
    : null;
}
function getTelegramId(user: PrivyUser): string | null {
  const tg = user.linked_accounts.find((a) => a.type === "telegram");
  return tg
    ? String((tg as { telegram_user_id?: string }).telegram_user_id ?? "") ||
        null
    : null;
}
function getTelegramUsername(user: PrivyUser): string | null {
  const tg = user.linked_accounts.find((a) => a.type === "telegram");
  return tg
    ? String((tg as { username?: string }).username ?? "") || null
    : null;
}

const withEmail = allPrivyUsers.filter((u) => getUserEmail(u) !== null);
const withoutEmail = allPrivyUsers.filter((u) => getUserEmail(u) === null);

console.info(`   With email:    ${withEmail.length}`);
console.info(
  `   Without email: ${withoutEmail.length} (social-only, linked at runtime)`,
);

// ─── Phase B: Pre-seed email users in Steward ─────────────────────────────────

console.info("\n📤 Phase B: Pre-seeding email users in Steward...");

if (!DRY_RUN) {
  // Verify Steward is reachable
  const healthOk = await fetch(`${STEWARD_API_URL}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!healthOk) {
    console.error(`❌ Steward is not reachable at ${STEWARD_API_URL}`);
    process.exit(1);
  }
}

let seeded = 0;
let existed = 0;
let failed = 0;

for (const user of withEmail) {
  const email = getUserEmail(user)!;

  if (DRY_RUN) {
    seeded++;
    continue;
  }

  const res = await fetch(`${STEWARD_API_URL}/platform/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Steward-Platform-Key": PLATFORM_KEY,
    },
    body: JSON.stringify({ email, emailVerified: true }),
  });

  const data = (await res.json()) as {
    ok: boolean;
    data?: { isNew: boolean };
    error?: string;
  };

  if (!data.ok) {
    failed++;
    console.warn(
      `\n   ⚠️  Failed to seed ${email}: ${data.error ?? "unknown error"}`,
    );
  } else if (data.data?.isNew) {
    seeded++;
  } else {
    existed++;
  }
}

if (DRY_RUN) {
  console.info(`✅ Dry run: would seed ${seeded} users`);
} else {
  console.info(`✅ Seeding complete:`);
  console.info(`   Created:  ${seeded}`);
  console.info(`   Existed:  ${existed}`);
  console.info(`   Failed:   ${failed}`);
}

// ─── Phase C: Write email-less user manifest ─────────────────────────────────

console.info("\n📄 Phase C: Writing email-less user manifest...");

const emaillessManifest: EmaillessUser[] = withoutEmail.map((u) => ({
  privyId: u.id,
  farcasterFid: getFarcasterFid(u),
  farcasterUsername: getFarcasterUsername(u),
  twitterUsername: getTwitterUsername(u),
  telegramId: getTelegramId(u),
  telegramUsername: getTelegramUsername(u),
}));

const migrationsDir = join(process.cwd(), "migrations");
if (!existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true });

const manifestPath = join(migrationsDir, "privy-emailless-users.json");

if (!DRY_RUN) {
  writeFileSync(manifestPath, JSON.stringify(emaillessManifest, null, 2));
  console.info(
    `✅ Wrote ${emaillessManifest.length} email-less users to migrations/privy-emailless-users.json`,
  );
} else {
  console.info(
    `✅ Dry run: would write ${emaillessManifest.length} entries to migrations/privy-emailless-users.json`,
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.info(`\n${"=".repeat(60)}`);
console.info("Migration summary:");
console.info(`  Total Privy users:    ${allPrivyUsers.length}`);
console.info(
  `  Pre-seeded in Steward: ${DRY_RUN ? `${seeded} (dry run)` : seeded}`,
);
console.info(`  Social-only (manifest): ${emaillessManifest.length}`);
console.info("");
console.info("Next steps:");
console.info("  1. Social-only users will be auto-linked at first login via");
console.info("     FID/Twitter/Telegram matching in auth-middleware.ts");
console.info("  2. Add migrations/privy-emailless-users.json to .gitignore");
console.info("  3. Monitor auth errors after deployment for any edge cases");
console.info("=".repeat(60));
