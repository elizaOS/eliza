/**
 * Content-manifest ledger store: lossless ordered shard rollover, idempotent
 * compare-and-swap publication, and restart-safe verified traversal for the
 * progressive-content continuity contract (#25141). Shards and the head are
 * persisted through the database adapter cache API (existing memory/database
 * domain); every read is strictly re-validated so tampered or corrupt bytes
 * fail with typed integrity errors instead of silent acceptance.
 */

import { createHash, randomBytes } from "node:crypto";
import { ElizaError } from "../errors";
import type {
  CompactionContentEntry,
  CompactionContentManifest,
} from "../types/content-manifest";
import {
  CONTENT_MANIFEST_LEDGER_MAX_SHARDS,
  CONTENT_MANIFEST_SHARD_DEFAULT_ENTRIES,
  CONTENT_MANIFEST_SHARD_MAX_BYTES,
  CONTENT_MANIFEST_SHARD_MAX_ENTRIES,
  ContentManifestIntegrityError,
  type ManifestHead,
  type ManifestShard,
  validateManifestHead,
  validateManifestShard,
} from "../types/content-manifest-shards";

/** Minimal adapter surface the ledger needs; satisfied by IDatabaseAdapter. */
export interface ContentManifestLedgerStore {
  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean>;
  getCaches<T>(keys: string[]): Promise<Map<string, T>>;
  setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean>;
  /** Optional best-effort cleanup of inert superseded shard rows. */
  deleteCaches?(keys: string[]): Promise<boolean>;
  compareAndSwapCache<T>(
    key: string,
    expectedRevision: number | null,
    nextRevision: number,
    value: T,
  ): Promise<boolean>;
}

export const CONTENT_MANIFEST_SHARD_KEY_PREFIX = "content-manifest-shard:";
export const CONTENT_MANIFEST_HEAD_KEY_PREFIX = "content-manifest-head:";

/**
 * Shard rows are generation-addressed: the publishing head's unique shard
 * generation is part of the key. A losing concurrent writer's shard bytes can
 * therefore never overwrite the winning generation's chain, and superseded
 * generations are inert until their head is replaced (then best-effort
 * cleaned).
 */
export function manifestShardKey(
  ledgerId: string,
  generation: string,
  sequence: number,
): string {
  return `${CONTENT_MANIFEST_SHARD_KEY_PREFIX}${ledgerId}:${generation}:${sequence}`;
}

export function manifestHeadKey(ledgerId: string): string {
  return `${CONTENT_MANIFEST_HEAD_KEY_PREFIX}${ledgerId}`;
}

/**
 * Canonical serialization for hashing: JSON of a validated object.
 * Validators reconstruct objects with literal key order and skip `undefined`,
 * so stringify of a validated value is byte-stable.
 */
export function canonicalShardBytes(shard: ManifestShard): string {
  return JSON.stringify(shard);
}

/**
 * Canonical chain-body bytes of a shard: every field except chainSha256
 * (self), nextSequence (unknowable before the next shard exists; pinned
 * instead by the validator's sequence+1 rule and the loader's continuity
 * checks), and byteLength (self-referential with the record length; pinned
 * instead by the loader's byteLength == canonical-bytes check, which binds
 * the exact stored record). createdAt IS included: a persisted shard's
 * bytes are frozen at publication (generation-addressed re-upserts write
 * identical bytes), so binding it costs nothing and a retimed createdAt
 * breaks the chain hash. Replacing an earlier shard's entries and patching
 * later prevSha256 links still changes every downstream chain hash and the
 * head's ledgerSha256.
 */
export function shardBodyBytes(
  shard: Omit<ManifestShard, "chainSha256" | "nextSequence">,
): string {
  return JSON.stringify(shard, (key, value) =>
    key === "chainSha256" || key === "nextSequence" || key === "byteLength"
      ? undefined
      : value,
  );
}

/** sha256(prevChainHex + bodyBytes) — the rolling full-record chain hash. */
export function computeChainSha256(prevChain: string, body: string): string {
  return createHash("sha256").update(prevChain).update(body).digest("hex");
}

export function hashEntries(entries: CompactionContentEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * Stable identity of a manifest entry for omission containment: the
 * authorized reference plus revision. Range growth is legitimate
 * progressive-content behavior (a later turn may authorize MORE of the same
 * reference), so ranges are compared as supersets at containment time, not
 * as part of identity.
 */
export function entryIdentity(entry: CompactionContentEntry): string {
  return JSON.stringify({
    kind: entry.reference.kind,
    ref: entry.reference.ref,
    revision: entry.revision ?? entry.reference.revision,
  });
}

/**
 * Range string used for subset comparison: a coarse interval key. Ranges
 * with identical unit/start/end are identical authorizations.
 */
function rangeKey(range: CompactionContentEntry["rangesUsed"][number]): string {
  return `${range.unit}:${range.start}:${range.end}`;
}

/**
 * True when every prior range for the same identity is still covered by the
 * replacement entry's ranges (exact-set or superset). Grown range sets pass;
 * shrunk or dropped ranges fail containment.
 */
export function rangesCoverPrior(
  prior: CompactionContentEntry,
  next: CompactionContentEntry,
): boolean {
  const nextRanges = new Set(next.rangesUsed.map(rangeKey));
  return prior.rangesUsed.every((range) => nextRanges.has(rangeKey(range)));
}

/** Entries of a manifest in publication order. */
export function entriesOf(
  manifest: CompactionContentManifest,
): CompactionContentEntry[] {
  return manifest.contentRefs;
}

/**
 * Content digest of a manifest's entries in publication order: the
 * authorization-bearing fields only (reference, revision, ranges). Used for
 * idempotency so identical content published at different times is
 * recognized regardless of chain-hash createdAt drift.
 */
export function contentDigestOf(entries: CompactionContentEntry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          kind: entry.reference.kind,
          ref: entry.reference.ref,
          referenceRevision: entry.reference.revision,
          revision: entry.revision,
          rangesUsed: entry.rangesUsed,
        })),
      ),
    )
    .digest("hex");
}

function entryCountOf(entries: CompactionContentEntry[]): number {
  return entries.length;
}

function rangeCountOf(entries: CompactionContentEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.rangesUsed.length, 0);
}

export interface BuildShardsOptions {
  ledgerId: string;
  /**
   * Split threshold for entries per shard (ceiling enforced regardless).
   * Defaults to CONTENT_MANIFEST_SHARD_DEFAULT_ENTRIES (64), deliberately
   * below the 256-reference ceiling the runtime derivation enforces so
   * count rollover is reachable for every valid runtime-derived manifest.
   */
  maxEntriesPerShard?: number;
  /** Split threshold for canonical shard bytes (ceiling enforced regardless). */
  maxBytesPerShard?: number;
  createdAt?: string;
}

export interface BuiltLedger {
  shards: ManifestShard[];
  head: ManifestHead;
}

/**
 * Split a manifest into ordered hash-chained shards, rolling over at entry
 * count or canonical byte bounds without ever dropping, reordering, or
 * deduplicating away an entry. A single entry larger than the byte bound still
 * occupies its own shard: rollover is lossless, not truncating.
 */
export function buildManifestShards(
  manifest: CompactionContentManifest,
  options: BuildShardsOptions,
): BuiltLedger {
  const maxEntries =
    options.maxEntriesPerShard ?? CONTENT_MANIFEST_SHARD_DEFAULT_ENTRIES;
  const maxBytes = options.maxBytesPerShard ?? CONTENT_MANIFEST_SHARD_MAX_BYTES;
  if (maxEntries > CONTENT_MANIFEST_SHARD_MAX_ENTRIES) {
    throw new ElizaError(
      "Manifest shard entry bound exceeds the schema ceiling",
      {
        code: "CONTENT_MANIFEST_SHARD_BOUND_INVALID",
        context: { maxEntries, ceiling: CONTENT_MANIFEST_SHARD_MAX_ENTRIES },
      },
    );
  }
  if (maxBytes > CONTENT_MANIFEST_SHARD_MAX_BYTES) {
    throw new ElizaError(
      "Manifest shard byte bound exceeds the schema ceiling",
      {
        code: "CONTENT_MANIFEST_SHARD_BOUND_INVALID",
        context: { maxBytes, ceiling: CONTENT_MANIFEST_SHARD_MAX_BYTES },
      },
    );
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  const entries = manifest.contentRefs;
  const shards: ManifestShard[] = [];
  let current: CompactionContentEntry[] = [];
  /**
   * Measure the canonical bytes a shard record carrying `draft` entries would
   * occupy, including the envelope fields (and the forward link it will gain
   * when a later shard follows). Packing must bound the full record, not the
   * bare entry sum, or the persisted record can exceed the byte ceiling.
   */
  const draftBytes = (draft: CompactionContentEntry[]): number => {
    const sequence = shards.length;
    const probe: ManifestShard = {
      schemaVersion: 1,
      ledgerId: options.ledgerId,
      sequence,
      entries: draft,
      entryCount: draft.length,
      // Overstate digits so the finalized byteLength can only shrink the
      // record, never grow it past the packing decision.
      byteLength: 1_000_000,
      entriesSha256: hashEntries(draft),
      ...(sequence === 0 ? {} : { prevSha256: "0".repeat(64) }),
      nextSequence: sequence + 1,
      chainSha256: "0".repeat(64),
      createdAt,
    };
    return Buffer.byteLength(canonicalShardBytes(probe), "utf8");
  };
  /**
   * Finalize the pending entries as the next shard. `hasFollowers` is known
   * at every call site: an in-loop flush always precedes another entry, and
   * the post-loop flush is the tail. Deciding the forward link (and the
   * previous shard's, already set when it was created) BEFORE computing
   * byteLength keeps every stored byteLength equal to the final canonical
   * record — the invariant the loader re-verifies.
   */
  const flush = (hasFollowers: boolean) => {
    if (current.length === 0) return;
    const sequence = shards.length;
    const entriesSha256 = hashEntries(current);
    const prev = shards[shards.length - 1];
    const body: Omit<ManifestShard, "chainSha256"> = {
      schemaVersion: 1,
      ledgerId: options.ledgerId,
      sequence,
      entries: current,
      entryCount: current.length,
      byteLength: 0,
      entriesSha256,
      ...(sequence === 0 ? {} : { prevSha256: prev.entriesSha256 }),
      ...(hasFollowers ? { nextSequence: sequence + 1 } : {}),
      createdAt,
    };
    const chainSha256 = computeChainSha256(
      prev ? prev.chainSha256 : "",
      shardBodyBytes(body),
    );
    const shard: ManifestShard = { ...body, chainSha256 };
    // byteLength commits the FINAL canonical record (chain hash included).
    // The field is part of its own serialization, so iterate to a fixed
    // point: assigning a longer digit run grows the record, which the next
    // pass re-measures. Converges within two passes; the loader and
    // validator re-verify the stored value against the persisted bytes.
    let measured = Buffer.byteLength(canonicalShardBytes(shard), "utf8");
    while (shard.byteLength !== measured) {
      shard.byteLength = measured;
      measured = Buffer.byteLength(canonicalShardBytes(shard), "utf8");
    }
    shard.byteLength = measured;
    if (shard.byteLength > maxBytes) {
      throw new ElizaError(
        "Manifest shard entry exceeds the configured byte bound even alone",
        {
          code: "CONTENT_MANIFEST_ENTRY_TOO_LARGE",
          context: {
            ledgerId: options.ledgerId,
            sequence,
            byteLength: shard.byteLength,
            maxBytes,
          },
        },
      );
    }
    shards.push(shard);
    current = [];
  };
  for (const entry of entries) {
    if (
      current.length > 0 &&
      (current.length >= maxEntries ||
        draftBytes([...current, entry]) > maxBytes)
    ) {
      flush(true);
    }
    current.push(entry);
  }
  flush(false);
  if (shards.length > CONTENT_MANIFEST_LEDGER_MAX_SHARDS) {
    throw new ElizaError("Manifest ledger exceeds the shard traversal bound", {
      code: "CONTENT_MANIFEST_LEDGER_TOO_LARGE",
      context: { shardCount: shards.length },
    });
  }
  const tail = shards[shards.length - 1];
  const head: ManifestHead = {
    schemaVersion: 1,
    ledgerId: options.ledgerId,
    headSequence: 0,
    shardGeneration: randomShardGeneration(),
    shardCount: shards.length,
    totalEntries: entryCountOf(entries),
    totalRanges: rangeCountOf(entries),
    ledgerSha256: tail.chainSha256,
    contentSha256: contentDigestOf(entries),
    revision: 0,
    updatedAt: createdAt,
  };
  return { shards, head };
}

/** Random 128-bit hex token making each publication's shard rows unique. */
function randomShardGeneration(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Idempotent, compare-and-swap-safe publication: shards are content-hashed and
 * written first (re-upserting identical bytes is harmless); the head is
 * published last with a revision CAS so a concurrent writer either observes an
 * identical ledger (no-op) or loses with a typed stale-publish error.
 */
export async function publishManifestLedger(
  store: ContentManifestLedgerStore,
  ledgerId: string,
  manifest: CompactionContentManifest,
  options?: Omit<BuildShardsOptions, "ledgerId">,
): Promise<ManifestHead> {
  const { shards, head } = buildManifestShards(manifest, {
    ledgerId,
    ...options,
  });
  const existingHead = await store.getCache<unknown>(manifestHeadKey(ledgerId));
  let expectedRevision: number | null = null;
  let superseded: { generation: string; shardCount: number } | null = null;
  if (existingHead !== undefined) {
    const prior = validateManifestHead(existingHead);
    // Idempotency: same content digest + same totals => the ledger is
    // already published; re-publishing identical content must be a no-op
    // even when the clock advanced between publications (createdAt is in
    // the chain hash but not the content digest).
    if (
      prior.contentSha256 === head.contentSha256 &&
      prior.totalEntries === head.totalEntries &&
      prior.totalRanges === head.totalRanges
    ) {
      return prior;
    }
    // Omission containment (#25141): a replacement ledger must carry every
    // reference the prior ledger authorized, with every previously used
    // range still covered (growth allowed, shrink/eviction not). Loading
    // the prior shards and comparing identities + range coverage fails
    // closed — a smaller manifest can never silently evict canonical
    // entries or drop ranges.
    const priorLedger = await loadManifestLedger(store, ledgerId);
    const newEntries = entriesOf(manifest);
    const newByIdentity = new Map(
      newEntries.map((entry) => [entryIdentity(entry), entry]),
    );
    const missing: string[] = [];
    for (const priorEntry of priorLedger.shards.flatMap((s) => s.entries)) {
      const identity = entryIdentity(priorEntry);
      const replacement = newByIdentity.get(identity);
      if (replacement === undefined) {
        missing.push(identity);
      } else if (!rangesCoverPrior(priorEntry, replacement)) {
        missing.push(identity);
      }
    }
    if (missing.length > 0) {
      throw new ElizaError(
        "Manifest ledger replacement omits prior authorized entries",
        {
          code: "CONTENT_MANIFEST_OMISSION",
          context: { ledgerId, missingCount: missing.length },
        },
      );
    }
    expectedRevision = prior.revision;
    superseded = {
      generation: prior.shardGeneration,
      shardCount: prior.shardCount,
    };
  }
  const written = await store.setCaches(
    shards.map((shard) => ({
      key: manifestShardKey(ledgerId, head.shardGeneration, shard.sequence),
      value: shard,
    })),
  );
  if (written === false) {
    throw new ElizaError(
      "Manifest ledger shard write failed before publication",
      {
        code: "CONTENT_MANIFEST_SHARD_WRITE_FAILED",
        context: { ledgerId, shardCount: shards.length },
      },
    );
  }
  const nextHead: ManifestHead = {
    ...head,
    revision: (expectedRevision ?? -1) + 1,
    updatedAt: new Date().toISOString(),
  };
  const swapped = await store.compareAndSwapCache(
    manifestHeadKey(ledgerId),
    expectedRevision,
    nextHead.revision,
    nextHead,
  );
  if (!swapped) {
    // CAS lost. Before surfacing a stale-publish error, reread the head:
    // when the winning writer published identical content this call is
    // idempotent and must succeed; only a genuinely divergent winner is
    // an error the caller observes (its next persist republishes).
    const reread = await store.getCache<unknown>(manifestHeadKey(ledgerId));
    if (reread !== undefined) {
      const winner = validateManifestHead(reread);
      if (
        winner.contentSha256 === head.contentSha256 &&
        winner.totalEntries === head.totalEntries &&
        winner.totalRanges === head.totalRanges
      ) {
        // Idempotent against the identical-content winner (content digest
        // ignores createdAt, so a clock advance cannot mask it). The losing
        // writer's own generation-addressed shard rows are inert — sweep
        // them (best effort) BEFORE returning so repeated identical races
        // do not accumulate unreachable rows.
        try {
          await store.deleteCaches?.(
            shards.map((shard) =>
              manifestShardKey(ledgerId, head.shardGeneration, shard.sequence),
            ),
          );
        } catch {
          // error-policy:J6 inert loser rows; a later superseding publish
          // sweeps by prior count.
        }
        return winner;
      }
    }
    // error-policy:J6 the losing writer's own shard rows are inert
    // (generation-addressed) and best-effort removed; failure to clean is
    // debug-only, never a reason to fail the typed stale-publish error.
    try {
      await store.deleteCaches?.(
        shards.map((shard) =>
          manifestShardKey(ledgerId, head.shardGeneration, shard.sequence),
        ),
      );
    } catch {
      // inert rows; the next superseding publish sweeps by prior count
    }
    throw new ElizaError(
      "Manifest ledger publication lost the compare-and-swap race",
      {
        code: "CONTENT_MANIFEST_STALE_PUBLISH",
        context: { ledgerId, expectedRevision },
      },
    );
  }
  if (superseded !== null) {
    // error-policy:J6 superseded generation's rows are unreachable through
    // the new head; best-effort cleanup sized by the PRIOR head's shard
    // count so a smaller replacement still sweeps every old row. Readers
    // mid-traversal re-read the head atomically under CAS; a reader that
    // already holds the old head may see shards vanish, which load reports
    // as a typed integrity error — never silent corruption.
    try {
      await store.deleteCaches?.(
        Array.from({ length: superseded.shardCount }, (_, sequence) =>
          manifestShardKey(ledgerId, superseded.generation, sequence),
        ),
      );
    } catch {
      // unreachable rows; harmless
    }
  }
  return nextHead;
}

/**
 * Derive every cache key a trajectory's published ledger occupies: the head
 * row plus the head-addressed shard generation's sequences. Returns null when
 * no head exists. Shared by the core prune guard and the agent archive path
 * so ledgers can never outlive their trajectory rows (#25141).
 */
export async function contentManifestLedgerKeys(
  store: Pick<ContentManifestLedgerStore, "getCache">,
  ledgerId: string,
): Promise<string[] | null> {
  const rawHead = await store.getCache<unknown>(manifestHeadKey(ledgerId));
  if (rawHead === undefined) return null;
  const head = validateManifestHead(rawHead);
  return [
    manifestHeadKey(ledgerId),
    ...Array.from({ length: head.shardCount }, (_, sequence) =>
      manifestShardKey(ledgerId, head.shardGeneration, sequence),
    ),
  ];
}

export interface LoadedLedger {
  head: ManifestHead;
  shards: ManifestShard[];
  entries: CompactionContentEntry[];
}

/**
 * Load and fully verify a ledger: head validation, ordered traversal from
 * sequence 0, per-shard strict validation, hash-chain and next-link
 * continuity, duplicate/reorder/cycle detection via sequence monotonicity and
 * a cross-shard entry-key set, and reconciliation against head totals. Any
 * mismatch throws a typed integrity error — never a silent accept.
 */
export async function loadManifestLedger(
  store: Pick<ContentManifestLedgerStore, "getCache" | "getCaches">,
  ledgerId: string,
): Promise<LoadedLedger> {
  const rawHead = await store.getCache<unknown>(manifestHeadKey(ledgerId));
  if (rawHead === undefined) {
    throw new ElizaError("Manifest ledger head is missing", {
      code: "CONTENT_MANIFEST_HEAD_MISSING",
      context: { ledgerId },
    });
  }
  const head = validateManifestHead(rawHead);
  const keys: string[] = [];
  for (let sequence = 0; sequence < head.shardCount; sequence++) {
    keys.push(manifestShardKey(ledgerId, head.shardGeneration, sequence));
  }
  const rawShards = await store.getCaches<unknown>(keys);
  const shards: ManifestShard[] = [];
  const entries: CompactionContentEntry[] = [];
  const seenEntryKeys = new Set<string>();
  for (let sequence = 0; sequence < head.shardCount; sequence++) {
    const raw = rawShards.get(
      manifestShardKey(ledgerId, head.shardGeneration, sequence),
    );
    if (raw === undefined) {
      throw new ContentManifestIntegrityError(
        "Manifest shard missing during traversal",
        { ledgerId, sequence },
      );
    }
    const shard = validateManifestShard(raw);
    if (shard.ledgerId !== ledgerId || shard.sequence !== sequence) {
      throw new ContentManifestIntegrityError(
        "Manifest shard identity does not match its position",
        {
          ledgerId,
          sequence,
          shardLedgerId: shard.ledgerId,
          shardSequence: shard.sequence,
        },
      );
    }
    if (hashEntries(shard.entries) !== shard.entriesSha256) {
      throw new ContentManifestIntegrityError(
        "Manifest shard entries hash mismatch",
        { ledgerId, sequence },
      );
    }
    // Full-record chain hash: binds entries, counts, prevSha256 link, and
    // createdAt — replacing an earlier shard and patching later entry
    // links still breaks every downstream chain hash.
    const expectedChain = computeChainSha256(
      sequence === 0 ? "" : shards[sequence - 1].chainSha256,
      shardBodyBytes(shard),
    );
    if (shard.chainSha256 !== expectedChain) {
      throw new ContentManifestIntegrityError(
        "Manifest shard chain hash mismatch",
        { ledgerId, sequence },
      );
    }
    // byteLength must equal the actual canonical record bytes.
    if (
      Buffer.byteLength(canonicalShardBytes(shard), "utf8") !== shard.byteLength
    ) {
      throw new ContentManifestIntegrityError(
        "Manifest shard byteLength does not match its canonical bytes",
        { ledgerId, sequence, stored: shard.byteLength },
      );
    }
    if (sequence > 0) {
      if (shard.prevSha256 !== shards[sequence - 1].entriesSha256) {
        throw new ContentManifestIntegrityError(
          "Manifest shard chain link mismatch",
          { ledgerId, sequence },
        );
      }
      if (shards[sequence - 1].nextSequence !== sequence) {
        throw new ContentManifestIntegrityError(
          "Manifest shard next-link discontinuity",
          { ledgerId, sequence },
        );
      }
    } else if (shard.prevSha256 !== undefined) {
      throw new ContentManifestIntegrityError(
        "Manifest shard sequence 0 must not carry a chain link",
        { ledgerId },
      );
    }
    const isTail = sequence === head.shardCount - 1;
    if (isTail && shard.nextSequence !== undefined) {
      throw new ContentManifestIntegrityError(
        "Manifest tail shard must not point past the ledger",
        { ledgerId, sequence, nextSequence: shard.nextSequence },
      );
    }
    for (const entry of shard.entries) {
      const key = `${entry.reference.kind}\u0000${entry.reference.ref}`;
      if (seenEntryKeys.has(key)) {
        throw new ContentManifestIntegrityError(
          "Manifest ledger contains a duplicate entry",
          {
            ledgerId,
            sequence,
            kind: entry.reference.kind,
            ref: entry.reference.ref,
          },
        );
      }
      seenEntryKeys.add(key);
      entries.push(entry);
    }
    shards.push(shard);
  }
  if (entries.length !== head.totalEntries) {
    throw new ContentManifestIntegrityError(
      "Manifest ledger entry total does not reconcile with the head",
      { ledgerId, total: entries.length, expected: head.totalEntries },
    );
  }
  const totalRanges = rangeCountOf(entries);
  if (totalRanges !== head.totalRanges) {
    throw new ContentManifestIntegrityError(
      "Manifest ledger range total does not reconcile with the head",
      { ledgerId, total: totalRanges, expected: head.totalRanges },
    );
  }
  const tail = shards[shards.length - 1];
  if (tail.chainSha256 !== head.ledgerSha256) {
    throw new ContentManifestIntegrityError(
      "Manifest ledger chain hash does not reconcile with the head",
      { ledgerId },
    );
  }
  return { head, shards, entries };
}
