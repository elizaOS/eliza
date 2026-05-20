#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { and, closeDatabase, db, eq, isNotNull, users } from '@babylon/db';
import { getAllVerifiedEmails, type PrivyLinkedAccount } from '@babylon/shared';
import {
  type LinkedAccount,
  PrivyClient,
  type User as PrivyUser,
} from '@privy-io/node';

type CliOptions = {
  databaseUrl: string;
  privyAppId: string;
  privyAppSecret: string;
  outputPath: string;
  privyLimit: number;
  maxPrivyPages: number | null;
};

type ContactRow = {
  email: string;
  name: string;
  source: 'db_verified' | 'db_unverified' | 'privy';
};

type ContactStats = {
  dbRowsScanned: number;
  dbCandidates: number;
  privyPagesScanned: number;
  privyUsersScanned: number;
  privyCandidates: number;
  duplicatesMerged: number;
  finalRows: number;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

function printUsage(): void {
  console.log(`
Export newsletter CSV (name,email) from DB + Privy

Usage:
  bun run scripts/export-newsletter-users-csv.ts [options]

Required options (or env fallback):
  --database-url <value>      PostgreSQL URL (fallback: DATABASE_URL)
  --privy-app-id <value>      Privy app ID (fallback: PRIVY_APP_ID or NEXT_PUBLIC_PRIVY_APP_ID)
  --privy-app-secret <value>  Privy app secret (fallback: PRIVY_APP_SECRET)

Optional:
  --output <path>             Output CSV path (default: ./debug/newsletter-users-<timestamp>.csv)
  --privy-limit <number>      Privy page size for list pagination (default: 100)
  --max-privy-pages <number>  Stop after N Privy pages (default: no limit)
  -h, --help                  Show this help

Notes:
  - Includes human users only from DB (excludes isActor/isAgent/isTest).
  - DB source includes syntactically valid emails present on User.email.
  - Privy source includes verified email linked accounts only.
  - Merges + deduplicates by lowercase email.
`);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readArgValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value after ${name}`);
  }
  return value.trim();
}

function hasFlag(args: string[], flag: '-h' | '--help'): boolean {
  return args.includes(flag);
}

function formatTimestampForFile(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 320) return null;
  if (!EMAIL_REGEX.test(trimmed)) return null;
  return trimmed;
}

function fallbackNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? email;
  const normalized = localPart.replace(/[._-]+/g, ' ').trim();
  return normalized.length > 0 ? normalized : email;
}

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function toNumericArg(value: string | undefined, argName: string): number {
  if (!value) {
    throw new Error(`Missing value for ${argName}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${argName}: ${value}`);
  }
  return parsed;
}

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);

  if (hasFlag(args, '-h') || hasFlag(args, '--help')) {
    printUsage();
    process.exit(0);
  }

  const databaseUrl =
    readArgValue(args, '--database-url') ?? readEnv('DATABASE_URL');
  const privyAppId =
    readArgValue(args, '--privy-app-id') ??
    readEnv('PRIVY_APP_ID') ??
    readEnv('NEXT_PUBLIC_PRIVY_APP_ID');
  const privyAppSecret =
    readArgValue(args, '--privy-app-secret') ?? readEnv('PRIVY_APP_SECRET');

  const outputPathArg = readArgValue(args, '--output');
  const outputPath = resolve(
    outputPathArg ??
      `./debug/newsletter-users-${formatTimestampForFile(new Date())}.csv`
  );

  const privyLimitRaw = readArgValue(args, '--privy-limit');
  const privyLimit = privyLimitRaw
    ? toNumericArg(privyLimitRaw, '--privy-limit')
    : 100;
  if (privyLimit > 100) {
    throw new Error('Invalid --privy-limit: maximum allowed value is 100');
  }

  const maxPrivyPagesRaw = readArgValue(args, '--max-privy-pages');
  const maxPrivyPages = maxPrivyPagesRaw
    ? toNumericArg(maxPrivyPagesRaw, '--max-privy-pages')
    : null;

  const missing: string[] = [];
  if (!databaseUrl)
    missing.push('database URL (--database-url or DATABASE_URL)');
  if (!privyAppId) {
    missing.push(
      'Privy app ID (--privy-app-id or PRIVY_APP_ID/NEXT_PUBLIC_PRIVY_APP_ID)'
    );
  }
  if (!privyAppSecret) {
    missing.push('Privy app secret (--privy-app-secret or PRIVY_APP_SECRET)');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required inputs: ${missing.join(', ')}`);
  }

  return {
    databaseUrl: databaseUrl!,
    privyAppId: privyAppId!,
    privyAppSecret: privyAppSecret!,
    outputPath,
    privyLimit,
    maxPrivyPages,
  };
}

function pickFirstString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const normalized = normalizeName(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function extractNameFromLinkedAccounts(
  accounts: LinkedAccount[]
): string | null {
  for (const account of accounts) {
    const accountRecord = account as unknown as Record<string, unknown>;

    const fullName = pickFirstString(accountRecord, [
      'display_name',
      'name',
      'username',
    ]);
    if (fullName && !fullName.includes('@')) {
      return fullName;
    }

    const firstName = pickFirstString(accountRecord, ['first_name']);
    const lastName = pickFirstString(accountRecord, ['last_name']);
    const combined = normalizeName(
      `${firstName ?? ''} ${lastName ?? ''}`.trim() || null
    );
    if (combined && !combined.includes('@')) {
      return combined;
    }
  }

  return null;
}

function getPrivyVerifiedEmails(user: PrivyUser): string[] {
  const linkedAccounts: PrivyLinkedAccount[] = user.linked_accounts.map(
    (account) => {
      if (account.type === 'email') {
        return {
          type: 'email',
          address: account.address,
          verified_at: account.verified_at,
          first_verified_at: account.first_verified_at ?? undefined,
          latest_verified_at: account.latest_verified_at ?? undefined,
        };
      }

      return {
        type: account.type,
      };
    }
  );

  return getAllVerifiedEmails({ linkedAccounts });
}

function chooseBetterName(
  current: string,
  incoming: string,
  email: string
): string {
  const normalizedCurrent =
    normalizeName(current) ?? fallbackNameFromEmail(email);
  const normalizedIncoming =
    normalizeName(incoming) ?? fallbackNameFromEmail(email);

  const fallback = fallbackNameFromEmail(email);

  const score = (name: string): number => {
    if (name === fallback) return 1;
    if (name.includes('@')) return 1;
    if (name.length <= 2) return 1;
    if (name.includes(' ')) return 3;
    return 2;
  };

  return score(normalizedIncoming) > score(normalizedCurrent)
    ? normalizedIncoming
    : normalizedCurrent;
}

function upsertContact(
  contactsByEmail: Map<string, ContactRow>,
  stats: ContactStats,
  next: ContactRow
): void {
  const existing = contactsByEmail.get(next.email);
  if (!existing) {
    contactsByEmail.set(next.email, next);
    return;
  }

  stats.duplicatesMerged += 1;

  const sourceRank = (source: ContactRow['source']): number => {
    if (source === 'db_verified') return 3;
    if (source === 'db_unverified') return 2;
    return 1;
  };

  const preferredSource =
    sourceRank(next.source) > sourceRank(existing.source)
      ? next.source
      : existing.source;

  const mergedName = chooseBetterName(existing.name, next.name, next.email);

  contactsByEmail.set(next.email, {
    email: next.email,
    name: mergedName,
    source: preferredSource,
  });
}

async function loadDbContacts(
  stats: ContactStats,
  contactsByEmail: Map<string, ContactRow>,
  dbNameByPrivyId: Map<string, string>
): Promise<void> {
  const dbRows = await db
    .select({
      id: users.id,
      privyId: users.privyId,
      displayName: users.displayName,
      username: users.username,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(
      and(
        eq(users.isActor, false),
        eq(users.isAgent, false),
        eq(users.isTest, false),
        isNotNull(users.email)
      )
    );

  stats.dbRowsScanned = dbRows.length;

  for (const row of dbRows) {
    const email = normalizeEmail(row.email);
    if (!email) continue;

    const explicitName =
      normalizeName(row.displayName) ?? normalizeName(row.username);
    const name = explicitName ?? fallbackNameFromEmail(email);

    if (row.privyId && explicitName) {
      dbNameByPrivyId.set(row.privyId, explicitName);
    }

    stats.dbCandidates += 1;

    upsertContact(contactsByEmail, stats, {
      email,
      name,
      source: row.emailVerified ? 'db_verified' : 'db_unverified',
    });
  }
}

async function loadPrivyContacts(
  options: CliOptions,
  stats: ContactStats,
  contactsByEmail: Map<string, ContactRow>,
  dbNameByPrivyId: Map<string, string>
): Promise<void> {
  const privyClient = new PrivyClient({
    appId: options.privyAppId,
    appSecret: options.privyAppSecret,
  });

  let page = await privyClient.users().list({ limit: options.privyLimit });

  while (true) {
    stats.privyPagesScanned += 1;

    for (const user of page.data) {
      stats.privyUsersScanned += 1;

      const emails = getPrivyVerifiedEmails(user);
      if (emails.length === 0) continue;

      const nameFromDb = dbNameByPrivyId.get(user.id) ?? null;
      const nameFromPrivy = extractNameFromLinkedAccounts(user.linked_accounts);

      for (const rawEmail of emails) {
        const email = normalizeEmail(rawEmail);
        if (!email) continue;

        const name =
          nameFromDb ?? nameFromPrivy ?? fallbackNameFromEmail(email);

        stats.privyCandidates += 1;

        upsertContact(contactsByEmail, stats, {
          email,
          name,
          source: 'privy',
        });
      }
    }

    if (stats.privyPagesScanned % 50 === 0) {
      console.log(
        `[Privy] Processed pages=${stats.privyPagesScanned}, users=${stats.privyUsersScanned}, candidates=${stats.privyCandidates}`
      );
    }

    const reachedPageLimit =
      options.maxPrivyPages !== null &&
      stats.privyPagesScanned >= options.maxPrivyPages;
    if (reachedPageLimit) break;

    if (!page.next_cursor) break;

    page = await page.getNextPage();
  }
}

function toCsv(rows: ContactRow[]): string {
  const lines = ['name,email'];

  for (const row of rows) {
    lines.push(`${csvEscape(row.name)},${csvEscape(row.email)}`);
  }

  return `${lines.join('\n')}\n`;
}

async function writeCsv(outputPath: string, content: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, content);
}

async function main(): Promise<void> {
  const options = parseCliOptions();

  process.env.DATABASE_URL = options.databaseUrl;

  const stats: ContactStats = {
    dbRowsScanned: 0,
    dbCandidates: 0,
    privyPagesScanned: 0,
    privyUsersScanned: 0,
    privyCandidates: 0,
    duplicatesMerged: 0,
    finalRows: 0,
  };

  const contactsByEmail = new Map<string, ContactRow>();
  const dbNameByPrivyId = new Map<string, string>();

  try {
    await loadDbContacts(stats, contactsByEmail, dbNameByPrivyId);
    await loadPrivyContacts(options, stats, contactsByEmail, dbNameByPrivyId);

    const finalRows = [...contactsByEmail.values()].sort((a, b) =>
      a.email.localeCompare(b.email)
    );

    stats.finalRows = finalRows.length;

    const csv = toCsv(finalRows);
    await writeCsv(options.outputPath, csv);

    console.log('Newsletter CSV export completed.');
    console.log(`- Output: ${options.outputPath}`);
    console.log(`- Final rows: ${stats.finalRows}`);
    console.log(`- DB rows scanned: ${stats.dbRowsScanned}`);
    console.log(`- DB candidates kept: ${stats.dbCandidates}`);
    console.log(`- Privy pages scanned: ${stats.privyPagesScanned}`);
    console.log(`- Privy users scanned: ${stats.privyUsersScanned}`);
    console.log(`- Privy candidates kept: ${stats.privyCandidates}`);
    console.log(`- Duplicates merged: ${stats.duplicatesMerged}`);
  } finally {
    await closeDatabase();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Newsletter CSV export failed: ${message}`);
    process.exit(1);
  });
