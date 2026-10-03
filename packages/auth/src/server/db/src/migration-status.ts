/** Validates the immutable migration ledger before serving identity requests. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type MigrationExpectation = {
  tag: string;
  createdAt: number;
  count: number;
};

type Journal = { entries?: Array<{ tag?: unknown; when?: unknown }> };

export type MigrationLedgerEntry = {
  hash: string;
  createdAt: number;
};

export type MigrationLedgerExpectation = {
  entries: MigrationLedgerEntry[];
};

export type MigrationLedgerReadiness = {
  ok: boolean;
  state: "exact" | "behind" | "ahead-known" | "ahead-unknown" | "corrupt";
  requiredCount: number;
  actualCount: number;
  forwardCount: number;
};

type AppliedMigrationLedgerEntry = {
  hash?: unknown;
  createdAt?: unknown;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

function normalizeAppliedEntry(
  entry: AppliedMigrationLedgerEntry,
): MigrationLedgerEntry | undefined {
  const createdAt =
    typeof entry.createdAt === "number"
      ? entry.createdAt
      : typeof entry.createdAt === "string" && /^\d+$/.test(entry.createdAt)
        ? Number(entry.createdAt)
        : Number.NaN;
  if (
    typeof entry.hash !== "string" ||
    !SHA256_HEX.test(entry.hash) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0
  ) {
    return undefined;
  }
  return { hash: entry.hash, createdAt };
}

function sameMigration(
  a: MigrationLedgerEntry,
  b: MigrationLedgerEntry,
): boolean {
  return a.hash === b.hash && a.createdAt === b.createdAt;
}

function isStrictlyForward(entries: readonly MigrationLedgerEntry[]): boolean {
  return entries.every(
    (entry, index) =>
      index === 0 || entry.createdAt > (entries[index - 1]?.createdAt ?? 0),
  );
}

function sameMigrationPrefix(
  entries: readonly MigrationLedgerEntry[],
  expected: readonly MigrationLedgerEntry[],
): boolean {
  return entries.every(
    (entry, index) => expected[index] && sameMigration(entry, expected[index]),
  );
}

/**
 * Validate the applied core migration ledger against the migrations required by
 * this release. Required migrations must be present with their exact hash and
 * timestamp. A well-formed forward suffix is accepted so an older application
 * can remain ready while a newer compatible release has already migrated the
 * shared database.
 *
 * `knownEntries` may include migrations newer than this release's required
 * floor. It only improves diagnostics (`ahead-known` versus `ahead-unknown`);
 * both states are ready. Missing, altered, duplicated, malformed, or
 * non-forward unknown entries remain fail-closed.
 */
export function assessMigrationLedger(
  appliedEntries: readonly AppliedMigrationLedgerEntry[],
  requiredEntries: readonly MigrationLedgerEntry[],
  knownEntries: readonly MigrationLedgerEntry[] = requiredEntries,
): MigrationLedgerReadiness {
  const base = {
    requiredCount: requiredEntries.length,
    actualCount: appliedEntries.length,
    forwardCount: Math.max(0, appliedEntries.length - requiredEntries.length),
  };
  const applied = appliedEntries.map(normalizeAppliedEntry);
  const required = requiredEntries.map(normalizeAppliedEntry);
  const known = knownEntries.map(normalizeAppliedEntry);
  if (
    requiredEntries.length === 0 ||
    applied.some((entry) => entry === undefined) ||
    required.some((entry) => entry === undefined) ||
    known.some((entry) => entry === undefined)
  ) {
    return { ok: false, state: "corrupt", ...base };
  }

  const normalizedApplied = applied as MigrationLedgerEntry[];
  const normalizedRequired = required as MigrationLedgerEntry[];
  const normalizedKnown = known as MigrationLedgerEntry[];
  const hasDuplicateCreatedAt = [
    normalizedApplied,
    normalizedRequired,
    normalizedKnown,
  ].some(
    (entries) =>
      new Set(entries.map((entry) => entry.createdAt)).size !== entries.length,
  );
  if (
    hasDuplicateCreatedAt ||
    !sameMigrationPrefix(
      normalizedRequired,
      normalizedKnown.slice(0, normalizedRequired.length),
    )
  ) {
    return { ok: false, state: "corrupt", ...base };
  }

  const missingRequired = normalizedRequired.find(
    (entry, index) =>
      !normalizedApplied[index] ||
      !sameMigration(normalizedApplied[index], entry),
  );
  if (missingRequired) {
    const onlyValidKnownPrefix = sameMigrationPrefix(
      normalizedApplied,
      normalizedKnown,
    );
    return {
      ok: false,
      state:
        onlyValidKnownPrefix &&
        normalizedApplied.length < normalizedRequired.length
          ? "behind"
          : "corrupt",
      ...base,
    };
  }

  if (normalizedApplied.length === normalizedRequired.length) {
    return { ok: true, state: "exact", ...base };
  }

  const forwardEntries = normalizedApplied.slice(normalizedRequired.length);
  const knownForwardEntries = normalizedKnown.slice(normalizedRequired.length);
  const knownForwardCount = Math.min(
    forwardEntries.length,
    knownForwardEntries.length,
  );
  if (
    !sameMigrationPrefix(
      forwardEntries.slice(0, knownForwardCount),
      knownForwardEntries,
    )
  ) {
    return { ok: false, state: "corrupt", ...base };
  }
  const unknownForwardEntries = forwardEntries.slice(knownForwardCount);
  const trustedPrefix = normalizedApplied.slice(
    0,
    normalizedRequired.length + knownForwardCount,
  );
  const trustedTip = Math.max(...trustedPrefix.map((entry) => entry.createdAt));
  if (
    unknownForwardEntries.length > 0 &&
    (unknownForwardEntries[0].createdAt <= trustedTip ||
      !isStrictlyForward(unknownForwardEntries))
  ) {
    return { ok: false, state: "corrupt", ...base };
  }
  return {
    ok: true,
    state: unknownForwardEntries.length === 0 ? "ahead-known" : "ahead-unknown",
    ...base,
  };
}

/** Return every checked-in core migration identity in journal order. */
export function getMigrationLedgerExpectation(): MigrationLedgerExpectation {
  const journalPath = new URL("../drizzle/meta/_journal.json", import.meta.url);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("migration journal is empty or malformed");
  }
  const entries = journal.entries.map((entry, index) => {
    if (
      typeof entry.tag !== "string" ||
      !/^[a-z0-9_]+$/.test(entry.tag) ||
      !Number.isSafeInteger(entry.when) ||
      (entry.when as number) <= 0
    ) {
      throw new Error(`migration journal entry ${index} is malformed`);
    }
    const sqlPath = new URL(`../drizzle/${entry.tag}.sql`, import.meta.url);
    return {
      hash: createHash("sha256").update(readFileSync(sqlPath)).digest("hex"),
      createdAt: entry.when as number,
    };
  });
  if (
    new Set(entries.map((entry) => entry.createdAt)).size !== entries.length
  ) {
    throw new Error("migration journal contains duplicate timestamps");
  }
  return { entries };
}

/**
 * Return the checked-in migration tip. Reading the journal keeps operational
 * diagnostics aligned with the migrator instead of duplicating a tag that
 * becomes stale whenever a migration is added.
 */
export function getMigrationExpectation(): MigrationExpectation {
  const path = new URL("../drizzle/meta/_journal.json", import.meta.url);
  const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
  const entries = journal.entries ?? [];
  const last = entries.at(-1);
  if (!last || typeof last.tag !== "string" || typeof last.when !== "number") {
    throw new Error("migration journal has no valid tip");
  }
  return { tag: last.tag, createdAt: last.when, count: entries.length };
}
