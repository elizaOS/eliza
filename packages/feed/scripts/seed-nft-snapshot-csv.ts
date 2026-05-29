#!/usr/bin/env bun

/**
 * Seed NftSnapshot from a CSV export (Top 100 snapshot style).
 *
 * Behavior:
 * - Resolves each CSV row to an existing user (id / privyId / username / walletAddress).
 * - Preserves users who already minted (hasMinted=true).
 * - Replaces all non-minted snapshot rows with the CSV set (upsert by userId).
 *
 * Usage:
 *   bun run scripts/seed-nft-snapshot-csv.ts --file "/path/to/file.csv"
 *   bun run scripts/seed-nft-snapshot-csv.ts --file "/path/to/file.csv" --snapshot-at "2025-12-31T23:59:59.000Z"
 *   bun run scripts/seed-nft-snapshot-csv.ts --file "/path/to/file.csv" --dry-run
 */

import { closeDatabase, db, eq, nftSnapshot, users } from "@feed/db";
import { parse } from "csv-parse/sync";
import { nanoid } from "nanoid";

type CliOptions = {
  file: string;
  snapshotAt: Date;
  dryRun: boolean;
};

type CsvRow = Record<string, string | undefined>;

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  const getArgValue = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  };

  const file = getArgValue("--file");
  if (!file) {
    throw new Error(
      'Missing required --file argument. Example: --file "/path/to/snapshot.csv"',
    );
  }

  const snapshotAtRaw = getArgValue("--snapshot-at");
  const snapshotAt = snapshotAtRaw ? new Date(snapshotAtRaw) : new Date();
  if (Number.isNaN(snapshotAt.getTime())) {
    throw new Error(`Invalid --snapshot-at value: ${snapshotAtRaw}`);
  }

  const dryRun = args.includes("--dry-run");

  return { file, snapshotAt, dryRun };
}

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWallet(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeUsername(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  return normalized ? normalized.toLowerCase() : null;
}

function parsePoints(row: CsvRow): number {
  const candidates = [
    row.reputationPoints,
    row.totalPoints,
    row.points,
    row.snapshotPoints,
  ];

  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (!normalized) continue;
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const csvRaw = await Bun.file(options.file).text();
  const rows = parse(csvRaw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as CsvRow[];

  if (rows.length === 0) {
    console.log("[SeedNftSnapshotCsv] CSV is empty. Nothing to import.");
    await closeDatabase();
    return;
  }

  const allUsers = await db
    .select({
      id: users.id,
      privyId: users.privyId,
      username: users.username,
      walletAddress: users.walletAddress,
    })
    .from(users);

  const byId = new Map<string, (typeof allUsers)[number]>();
  const byHistoricalAuthId = new Map<string, (typeof allUsers)[number]>();
  const byUsername = new Map<string, (typeof allUsers)[number]>();
  const byWallet = new Map<string, (typeof allUsers)[number]>();

  for (const user of allUsers) {
    const id = normalize(user.id);
    if (id) byId.set(id, user);

    const historicalAuthId = normalize(user.privyId);
    if (historicalAuthId) byHistoricalAuthId.set(historicalAuthId, user);

    const username = normalizeUsername(user.username);
    if (username) byUsername.set(username, user);

    const wallet = normalizeWallet(user.walletAddress);
    if (wallet) byWallet.set(wallet, user);
  }

  const resolved: Array<{
    userId: string;
    walletAddress: string | null;
    rank: number;
    points: number;
  }> = [];
  const unresolved: Array<{ row: number; id: string | null }> = [];
  const seenUserIds = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rank = i + 1;

    const rowId = normalize(row.id);
    const rowHistoricalAuthId = normalize(row.privyId);
    const rowUsername = normalizeUsername(row.username);
    const rowWallet = normalizeWallet(row.walletAddress);

    const user =
      (rowId ? byId.get(rowId) : undefined) ??
      (rowHistoricalAuthId
        ? byHistoricalAuthId.get(rowHistoricalAuthId)
        : undefined) ??
      (rowUsername ? byUsername.get(rowUsername) : undefined) ??
      (rowWallet ? byWallet.get(rowWallet) : undefined);

    if (!user) {
      unresolved.push({ row: rank, id: rowId });
      continue;
    }

    if (seenUserIds.has(user.id)) continue;
    seenUserIds.add(user.id);

    resolved.push({
      userId: user.id,
      walletAddress: normalizeWallet(row.walletAddress ?? user.walletAddress),
      rank,
      points: parsePoints(row),
    });
  }

  const existingSnapshots = await db
    .select({
      userId: nftSnapshot.userId,
      hasMinted: nftSnapshot.hasMinted,
    })
    .from(nftSnapshot);

  const mintedUserIds = new Set(
    existingSnapshots.filter((s) => s.hasMinted).map((s) => s.userId),
  );

  console.log("[SeedNftSnapshotCsv] Summary before write");
  console.log(`- CSV rows: ${rows.length}`);
  console.log(`- Resolved users: ${resolved.length}`);
  console.log(`- Unresolved rows: ${unresolved.length}`);
  console.log(`- Existing minted snapshots preserved: ${mintedUserIds.size}`);
  console.log(`- Snapshot time: ${options.snapshotAt.toISOString()}`);
  console.log(`- Dry run: ${options.dryRun ? "yes" : "no"}`);

  if (unresolved.length > 0) {
    const preview = unresolved.slice(0, 10);
    console.log("[SeedNftSnapshotCsv] First unresolved rows (up to 10):");
    for (const entry of preview) {
      console.log(`  row=${entry.row} id=${entry.id ?? "null"}`);
    }
  }

  if (options.dryRun) {
    await closeDatabase();
    return;
  }

  // Replace non-minted snapshot rows.
  for (const snapshot of existingSnapshots) {
    if (!snapshot.hasMinted) {
      await db
        .delete(nftSnapshot)
        .where(eq(nftSnapshot.userId, snapshot.userId));
    }
  }

  let insertedOrUpdated = 0;
  let skippedMinted = 0;

  for (const row of resolved) {
    if (mintedUserIds.has(row.userId)) {
      skippedMinted++;
      continue;
    }

    await db
      .insert(nftSnapshot)
      .values({
        id: nanoid(),
        userId: row.userId,
        walletAddress: row.walletAddress,
        rank: row.rank,
        points: row.points,
        snapshotTakenAt: options.snapshotAt,
        hasMinted: false,
      })
      .onConflictDoUpdate({
        target: nftSnapshot.userId,
        set: {
          walletAddress: row.walletAddress,
          rank: row.rank,
          points: row.points,
          snapshotTakenAt: options.snapshotAt,
        },
      });

    insertedOrUpdated++;
  }

  console.log("[SeedNftSnapshotCsv] Done");
  console.log(`- Inserted/updated: ${insertedOrUpdated}`);
  console.log(`- Skipped (already minted): ${skippedMinted}`);
  console.log(`- Unresolved (not imported): ${unresolved.length}`);

  await closeDatabase();
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[SeedNftSnapshotCsv] Failed: ${message}`);
  await closeDatabase();
  process.exit(1);
});
