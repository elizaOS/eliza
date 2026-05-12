import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnnotatedPromptSegment,
  buildModelHash,
  cacheRoot,
  DEFAULT_CACHE_TTLS,
  deriveSlotId,
  evictExpired,
  extractAnnotatedSegments,
  extractConversationId,
  extractPrefixHash,
  extractPromptCacheKey,
  hashStablePrefix,
  llamaCacheRoot,
  parseSlotCacheTtlClass,
  readCacheStats,
  resolveLocalCacheKey,
  slotCacheFileName,
  slotSavePath,
  ttlMsForKey,
} from "./cache-bridge";

describe("cache-bridge slot derivation", () => {
  it("returns -1 when parallel is 0 or negative", () => {
    expect(deriveSlotId("v5:abc", 0)).toBe(-1);
    expect(deriveSlotId("v5:abc", -3)).toBe(-1);
  });

  it("returns -1 for empty key even with parallel > 0", () => {
    expect(deriveSlotId("", 4)).toBe(-1);
  });

  it("always returns 0 when parallel is 1", () => {
    expect(deriveSlotId("v5:abc", 1)).toBe(0);
    expect(deriveSlotId("v5:zzz", 1)).toBe(0);
  });

  it("is deterministic for the same key+parallel", () => {
    const a = deriveSlotId("v5:cache-key-1", 4);
    const b = deriveSlotId("v5:cache-key-1", 4);
    expect(a).toBe(b);
  });

  it("returns slot ids in [0, parallel)", () => {
    const parallel = 8;
    for (let i = 0; i < 200; i += 1) {
      const slot = deriveSlotId(`v5:key-${i}`, parallel);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(parallel);
    }
  });

  it("spreads keys across slots roughly uniformly", () => {
    const parallel = 4;
    const counts = new Array<number>(parallel).fill(0);
    for (let i = 0; i < 800; i += 1) {
      const slot = deriveSlotId(`v5:key-${i}`, parallel);
      counts[slot] = (counts[slot] ?? 0) + 1;
    }
    // Expect every slot to receive a non-trivial share. With 800/4 = 200
    // average, the chance any slot has < 100 by hash collision is
    // negligible for SHA-256 truncation.
    for (const count of counts) {
      expect(count).toBeGreaterThan(100);
    }
  });
});

describe("cache-bridge path layout", () => {
  const originalState = process.env.ELIZA_STATE_DIR;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-cache-test-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (originalState === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalState;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("places llamaCacheRoot under the local-inference root", () => {
    const root = llamaCacheRoot();
    expect(root.startsWith(stateDir)).toBe(true);
    expect(root.endsWith(path.join("local-inference", "llama-cache"))).toBe(
      true,
    );
  });

  it("scopes cacheRoot by model hash", () => {
    const a = cacheRoot("aaaa1111");
    const b = cacheRoot("bbbb2222");
    expect(a).not.toBe(b);
    expect(a.endsWith(path.join("llama-cache", "aaaa1111"))).toBe(true);
    expect(slotSavePath("aaaa1111")).toBe(a);
  });

  it("rejects empty model hash", () => {
    expect(() => cacheRoot("")).toThrow(/non-empty modelHash/);
  });

  it("buildModelHash is stable + sensitive to its inputs", () => {
    const a = buildModelHash({
      targetModelPath: "/models/eliza-1-0_6b.gguf",
      drafterModelPath: "/models/eliza-1-0_6b-drafter.gguf",
      cacheTypeK: "f16",
      cacheTypeV: "f16",
    });
    const b = buildModelHash({
      targetModelPath: "/models/eliza-1-0_6b.gguf",
      drafterModelPath: "/models/eliza-1-0_6b-drafter.gguf",
      cacheTypeK: "f16",
      cacheTypeV: "f16",
    });
    expect(a).toBe(b);
    const c = buildModelHash({
      targetModelPath: "/models/eliza-1-0_6b.gguf",
      drafterModelPath: "/models/other-drafter.gguf",
      cacheTypeK: "f16",
      cacheTypeV: "f16",
    });
    expect(c).not.toBe(a);
    const d = buildModelHash({
      targetModelPath: "/models/eliza-1-0_6b.gguf",
      drafterModelPath: "/models/eliza-1-0_6b-drafter.gguf",
      cacheTypeK: "q8_0",
      cacheTypeV: "f16",
    });
    expect(d).not.toBe(a);
  });
});

describe("cache-bridge eviction by mtime + TTL", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-cache-evict-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns 0 when the directory does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(evictExpired(missing)).resolves.toBe(0);
  });

  it("deletes only files older than the largest TTL", async () => {
    const fresh = path.join(dir, "fresh.bin");
    const stale = path.join(dir, "stale.bin");
    await fs.writeFile(fresh, "hot");
    await fs.writeFile(stale, "cold");
    const now = Date.now();
    // Mtimes are floored to ms by the kernel; pass values comfortably
    // older than the configured horizon.
    const oldTime = new Date(
      now - (DEFAULT_CACHE_TTLS.extended ?? DEFAULT_CACHE_TTLS.long) - 60_000,
    );
    await fs.utimes(stale, oldTime, oldTime);

    const deleted = await evictExpired(dir, DEFAULT_CACHE_TTLS, now);
    expect(deleted).toBe(1);
    await expect(fs.stat(fresh)).resolves.toBeDefined();
    await expect(fs.stat(stale)).rejects.toThrow();
  });

  it("respects the now argument for deterministic tests", async () => {
    const file = path.join(dir, "x.bin");
    await fs.writeFile(file, "x");
    const now = Date.now();
    // File counts as "stale" only when now drifts past horizon.
    const earlyDeleted = await evictExpired(dir, DEFAULT_CACHE_TTLS, now);
    expect(earlyDeleted).toBe(0);
    const later =
      now + (DEFAULT_CACHE_TTLS.extended ?? DEFAULT_CACHE_TTLS.long) + 60_000;
    const lateDeleted = await evictExpired(dir, DEFAULT_CACHE_TTLS, later);
    expect(lateDeleted).toBe(1);
  });

  it("ignores subdirectories", async () => {
    const sub = path.join(dir, "subdir");
    await fs.mkdir(sub, { recursive: true });
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    await fs.utimes(sub, old, old);
    const deleted = await evictExpired(dir);
    expect(deleted).toBe(0);
  });

  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  };

  it("honors the per-file TTL class encoded in the filename", async () => {
    const shortFile = path.join(dir, slotCacheFileName("conv-a", "short"));
    const longFile = path.join(dir, slotCacheFileName("conv-b", "long"));
    const legacyFile = path.join(dir, "conv-c.bin");
    await fs.writeFile(shortFile, "s");
    await fs.writeFile(longFile, "l");
    await fs.writeFile(legacyFile, "x");
    const now = Date.now();
    // Age every file to "older than short, younger than long".
    const aged = new Date(now - DEFAULT_CACHE_TTLS.short - 60_000);
    await fs.utimes(shortFile, aged, aged);
    await fs.utimes(longFile, aged, aged);
    await fs.utimes(legacyFile, aged, aged);

    const deleted = await evictExpired(dir, DEFAULT_CACHE_TTLS, now);
    // Only the short-TTL file is past its horizon; the long-TTL and
    // legacy (treated as long) files survive.
    expect(deleted).toBe(1);
    expect(await exists(shortFile)).toBe(false);
    expect(await exists(longFile)).toBe(true);
    expect(await exists(legacyFile)).toBe(true);
  });

  it("deletes long-TTL files once past the long horizon", async () => {
    const longFile = path.join(dir, slotCacheFileName("conv-b", "long"));
    const legacyFile = path.join(dir, "conv-c.bin");
    await fs.writeFile(longFile, "l");
    await fs.writeFile(legacyFile, "x");
    const now = Date.now();
    const aged = new Date(now - DEFAULT_CACHE_TTLS.long - 60_000);
    await fs.utimes(longFile, aged, aged);
    await fs.utimes(legacyFile, aged, aged);
    const deleted = await evictExpired(dir, DEFAULT_CACHE_TTLS, now);
    expect(deleted).toBe(2);
  });
});

describe("cache-bridge slot cache filenames", () => {
  it("round-trips the TTL class through the filename", () => {
    expect(slotCacheFileName("room-1", "long")).toBe("room-1.long.bin");
    expect(slotCacheFileName("room-1", "short")).toBe("room-1.short.bin");
    expect(parseSlotCacheTtlClass("room-1.long.bin")).toBe("long");
    expect(parseSlotCacheTtlClass("room-1.short.bin")).toBe("short");
    expect(parseSlotCacheTtlClass("room-1.extended.bin")).toBe("extended");
  });

  it("returns undefined for legacy / unencoded filenames", () => {
    expect(parseSlotCacheTtlClass("room-1.bin")).toBeUndefined();
    expect(parseSlotCacheTtlClass("room-1")).toBeUndefined();
    expect(parseSlotCacheTtlClass("room.with.dots.bin")).toBeUndefined();
  });

  it("handles conversation ids that themselves contain dots", () => {
    const name = slotCacheFileName("a.b.c-room", "long");
    expect(name).toBe("a.b.c-room.long.bin");
    expect(parseSlotCacheTtlClass(name)).toBe("long");
  });
});

describe("cache-bridge stats", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-cache-stats-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns [] for missing dirs", async () => {
    const missing = path.join(dir, "absent");
    await expect(readCacheStats(missing)).resolves.toEqual([]);
  });

  it("reports file size + mtime + age", async () => {
    const a = path.join(dir, "a.bin");
    await fs.writeFile(a, "abc");
    const now = Date.now();
    const stats = await readCacheStats(dir, now + 1_000);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.file).toBe("a.bin");
    expect(stats[0]?.sizeBytes).toBe(3);
    expect(stats[0]?.ageMs).toBeGreaterThanOrEqual(0);
  });
});

describe("cache-bridge ttl mapping", () => {
  it("maps short/long/extended/undefined", () => {
    expect(ttlMsForKey(undefined)).toBe(DEFAULT_CACHE_TTLS.short);
    expect(ttlMsForKey("short")).toBe(DEFAULT_CACHE_TTLS.short);
    expect(ttlMsForKey("long")).toBe(DEFAULT_CACHE_TTLS.long);
    expect(ttlMsForKey("extended")).toBe(DEFAULT_CACHE_TTLS.extended);
  });

  it("falls back to long when extended is unset", () => {
    const ttls = { short: 1, long: 2 };
    expect(ttlMsForKey("extended", ttls)).toBe(2);
  });
});

describe("cache-bridge extractPromptCacheKey", () => {
  it("reads from providerOptions.eliza.promptCacheKey", () => {
    expect(
      extractPromptCacheKey({
        eliza: { promptCacheKey: "v5:hash" },
      }),
    ).toBe("v5:hash");
  });

  it("returns null for missing/invalid shapes", () => {
    expect(extractPromptCacheKey(null)).toBeNull();
    expect(extractPromptCacheKey(undefined)).toBeNull();
    expect(extractPromptCacheKey("not-an-object")).toBeNull();
    expect(extractPromptCacheKey({})).toBeNull();
    expect(extractPromptCacheKey({ eliza: {} })).toBeNull();
    expect(extractPromptCacheKey({ eliza: { promptCacheKey: "" } })).toBeNull();
    expect(extractPromptCacheKey({ eliza: { promptCacheKey: 42 } })).toBeNull();
  });
});

describe("cache-bridge stable-prefix hashing", () => {
  it("hashes only the stable prefix and ignores tail drift", () => {
    const stablePrefix: AnnotatedPromptSegment[] = [
      { content: "system: you are a helpful assistant", stable: true },
      { content: "tools: search, calculator", stable: true },
    ];
    const withTimestampA: AnnotatedPromptSegment[] = [
      ...stablePrefix,
      { content: "now: 2026-05-09T18:00:00Z", stable: false },
    ];
    const withTimestampB: AnnotatedPromptSegment[] = [
      ...stablePrefix,
      { content: "now: 2026-05-09T18:00:01Z", stable: false },
    ];
    const hashA = hashStablePrefix(withTimestampA);
    const hashB = hashStablePrefix(withTimestampB);
    expect(hashA).not.toBeNull();
    expect(hashB).toBe(hashA);
  });

  it("returns null when no stable segment exists", () => {
    expect(
      hashStablePrefix([
        { content: "tail only", stable: false },
        { content: "more tail", stable: false },
      ]),
    ).toBeNull();
  });

  it("stops at the first unstable segment so a later stable does not contribute", () => {
    const a: AnnotatedPromptSegment[] = [
      { content: "stable-1", stable: true },
      { content: "unstable-1", stable: false },
      { content: "stable-2-late", stable: true },
    ];
    const b: AnnotatedPromptSegment[] = [
      { content: "stable-1", stable: true },
      { content: "unstable-2-different", stable: false },
      { content: "stable-2-late", stable: true },
    ];
    expect(hashStablePrefix(a)).toBe(hashStablePrefix(b));
    expect(hashStablePrefix([{ content: "stable-1", stable: true }])).toBe(
      hashStablePrefix(a),
    );
  });

  it("returns 16 hex chars when input is non-empty stable", () => {
    const hash = hashStablePrefix([{ content: "x", stable: true }]);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("cache-bridge extractAnnotatedSegments", () => {
  it("reads valid {content,stable} arrays from providerOptions.eliza", () => {
    const input = {
      eliza: {
        promptSegments: [
          { content: "a", stable: true },
          { content: "b", stable: false },
        ],
      },
    };
    expect(extractAnnotatedSegments(input)).toEqual([
      { content: "a", stable: true },
      { content: "b", stable: false },
    ]);
  });

  it("returns null on malformed segments", () => {
    expect(extractAnnotatedSegments(null)).toBeNull();
    expect(extractAnnotatedSegments({})).toBeNull();
    expect(extractAnnotatedSegments({ eliza: {} })).toBeNull();
    expect(
      extractAnnotatedSegments({
        eliza: { promptSegments: [{ stable: true }] },
      }),
    ).toBeNull();
    expect(
      extractAnnotatedSegments({
        eliza: { promptSegments: [{ content: "x" }] },
      }),
    ).toBeNull();
    expect(
      extractAnnotatedSegments({
        eliza: { promptSegments: "not-an-array" },
      }),
    ).toBeNull();
  });
});

describe("cache-bridge extractConversationId", () => {
  it("reads from providerOptions.eliza.conversationId", () => {
    expect(extractConversationId({ eliza: { conversationId: "room-1" } })).toBe(
      "room-1",
    );
  });

  it("returns null when missing or empty", () => {
    expect(extractConversationId(null)).toBeNull();
    expect(extractConversationId({})).toBeNull();
    expect(extractConversationId({ eliza: {} })).toBeNull();
    expect(extractConversationId({ eliza: { conversationId: "" } })).toBeNull();
  });
});

describe("cache-bridge extractPrefixHash", () => {
  it("reads from providerOptions.eliza.prefixHash", () => {
    expect(extractPrefixHash({ eliza: { prefixHash: "abc123" } })).toBe(
      "abc123",
    );
  });

  it("returns null when missing or non-string", () => {
    expect(extractPrefixHash(null)).toBeNull();
    expect(extractPrefixHash({ eliza: { prefixHash: 42 } })).toBeNull();
    expect(extractPrefixHash({ eliza: { prefixHash: "" } })).toBeNull();
  });
});

describe("cache-bridge resolveLocalCacheKey precedence", () => {
  it("prefers conversationId over everything else", () => {
    const opts = {
      eliza: {
        conversationId: "room-1",
        promptSegments: [{ content: "x", stable: true }],
        prefixHash: "abc",
        promptCacheKey: "v5:abc",
      },
    };
    expect(resolveLocalCacheKey(opts)).toBe("conv:room-1");
  });

  it("falls through to stable-prefix hash when no conversationId", () => {
    const opts = {
      eliza: {
        promptSegments: [
          { content: "stable", stable: true },
          { content: "now: 12345", stable: false },
        ],
        prefixHash: "abc",
        promptCacheKey: "v5:abc",
      },
    };
    const key = resolveLocalCacheKey(opts);
    expect(key).not.toBeNull();
    expect(key?.startsWith("seg:")).toBe(true);
  });

  it("falls through to prefixHash when no segments", () => {
    expect(
      resolveLocalCacheKey({
        eliza: { prefixHash: "abc", promptCacheKey: "v5:abc" },
      }),
    ).toBe("pfx:abc");
  });

  it("falls through to promptCacheKey as last resort", () => {
    expect(resolveLocalCacheKey({ eliza: { promptCacheKey: "v5:abc" } })).toBe(
      "v5:abc",
    );
  });

  it("returns null when nothing is provided", () => {
    expect(resolveLocalCacheKey(null)).toBeNull();
    expect(resolveLocalCacheKey({})).toBeNull();
    expect(resolveLocalCacheKey({ eliza: {} })).toBeNull();
  });

  it("a runtime timestamp in the unstable tail does not change the cache key", () => {
    const opts1 = {
      eliza: {
        promptSegments: [
          { content: "system: you are helpful", stable: true },
          { content: "tools: a, b, c", stable: true },
          { content: "now: 2026-05-09T18:00:00Z", stable: false },
        ],
      },
    };
    const opts2 = {
      eliza: {
        promptSegments: [
          { content: "system: you are helpful", stable: true },
          { content: "tools: a, b, c", stable: true },
          { content: "now: 2026-05-09T18:00:01Z", stable: false },
        ],
      },
    };
    expect(resolveLocalCacheKey(opts1)).toBe(resolveLocalCacheKey(opts2));
  });
});
