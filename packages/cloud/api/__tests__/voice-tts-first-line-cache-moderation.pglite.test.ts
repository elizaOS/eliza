/**
 * `POST /api/v1/voice/tts` reads the first-line cache while content
 * moderation is in flight, and a request that moderation refuses leaves the
 * cache exactly as it found it. The read that overlaps moderation writes
 * nothing; the bookkeeping a lookup owes (hit count, LRU touch, dropping an
 * orphan row) runs only after moderation passes, and only against the row as
 * it is then: a row repaired, rewritten or evicted while moderation was
 * pending is re-read, never settled from the earlier read. The catalog price
 * is read only after moderation passes and the cache misses. Real first-line
 * cache service on PGlite with an in-memory R2 bucket; auth, content safety,
 * pricing, the ElevenLabs client and usage records are replaced.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import { AiPricingCacheWarmingError } from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import * as elevenlabs from "@elizaos/cloud-shared/lib/services/elevenlabs";
import {
  type CloudFirstLineCacheKey,
  CloudFirstLineCacheService,
  fingerprintCloudVoiceSettings,
  getCloudFirstLineCacheService,
} from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import {
  type RuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@elizaos/cloud-shared/lib/storage/r2-runtime-binding";
import { FIRST_SENTENCE_SNIP_VERSION, firstSentenceSnip } from "@elizaos/voice";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const orgId = randomUUID();
const userId = randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(5);
  }
};

/** Ordered marks from moderation, the price read, R2 reads and paid steps. */
const events: string[] = [];
const passingGates = () => ({
  moderation: async (): Promise<unknown> => ({}),
  price: async (): Promise<void> => undefined,
});
let gates = passingGates();
afterEach(() => {
  gates = passingGates();
  events.length = 0;
});

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: userId, organization_id: orgId },
    apiKeyId: null,
    admissionSnapshot: undefined,
    credential: undefined,
  }),
  // No request in this file may reach paid admission.
  admitFlatGenerativeOperation: async () => {
    events.push("admission");
    throw new Error("paid admission is outside this test");
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse: () => gates.moderation() },
}));
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  ...aiPricing,
  calculateTTSCostFromCatalog: async ({
    characterCount,
  }: {
    characterCount: number;
  }) => {
    events.push("price:start");
    await gates.price();
    return {
      totalCost: characterCount * 0.001,
      baseTotalCost: characterCount * 0.0008,
      platformMarkup: characterCount * 0.0002,
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/elevenlabs", () => ({
  ...elevenlabs,
  getElevenLabsService: () => ({
    textToSpeech: async () => {
      events.push("synthesis");
      throw new Error("synthesis is outside this test");
    },
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/usage", () => ({
  usageService: { create: async () => ({}) },
}));

/** In-memory R2 bucket; every read is marked in `events`. */
const blobs = new Map<string, { bytes: Uint8Array; contentType?: string }>();
const bucket: RuntimeR2Bucket = {
  async get(key) {
    events.push("r2:get");
    const blob = blobs.get(key);
    if (!blob) return null;
    const bytes = blob.bytes.slice();
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer,
    };
  },
  async put(key, value, options) {
    if (!(value instanceof ArrayBuffer)) {
      throw new Error("the first-line cache writes ArrayBuffer blobs");
    }
    blobs.set(key, {
      bytes: new Uint8Array(value.slice(0)),
      contentType: options?.httpMetadata?.contentType,
    });
  },
  async delete(key) {
    blobs.delete(key);
  },
};
setRuntimeR2Bucket(bucket);

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { ttsFirstLineCache } = await import("@elizaos/cloud-shared/db/schemas");
const { default: ttsRoute } = await import("../v1/voice/tts/route");

const pg = () => getPgliteClientForTests();
const app = new Hono();
app.route("/api/v1/voice/tts", ttsRoute);

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ ttsFirstLineCache }, empty.id),
  )) {
    await pg().exec(statement.replaceAll('"public".', ""));
  }
});
afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

/** The key the route builds for a whole-input opener on the default voice. */
function openerKey(text: string): CloudFirstLineCacheKey {
  const snip = firstSentenceSnip(text);
  if (!snip) throw new Error(`not a cacheable opener: ${text}`);
  const voiceId = "EXAVITQu4vr4xnSDxMaL";
  return {
    algoVersion: FIRST_SENTENCE_SNIP_VERSION,
    provider: "elevenlabs",
    voiceId,
    voiceRevision: `elevenlabs:${voiceId}:eleven_flash_v2_5:mp3_44100_128`,
    sampleRate: 44100,
    codec: "mp3",
    voiceSettingsFingerprint: fingerprintCloudVoiceSettings({
      outputFormat: "mp3_44100_128",
    }),
    normalizedText: snip.normalized,
    scope: "global",
  };
}

/** Stores an opener through the real cache; returns its row, blob key and bytes. */
async function seedOpener(
  text: string,
  bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, text.length]),
) {
  const snip = firstSentenceSnip(text);
  if (!snip) throw new Error(`not a cacheable opener: ${text}`);
  const stored = await getCloudFirstLineCacheService().put({
    ...openerKey(text),
    bytes,
    rawText: snip.raw,
    contentType: "audio/mpeg",
    durationMs: 0,
    wordCount: snip.wordCount,
  });
  if (!stored) throw new Error(`cache refused the seed for: ${text}`);
  const { rows } = await pg().query<{ id: string; blob_key: string }>(
    "SELECT id, blob_key FROM tts_first_line_cache WHERE normalized_text=$1",
    [snip.normalized],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error(`no single row for: ${text}`);
  return { id: row.id, blobKey: row.blob_key, bytes };
}

/** The manifest rows for one opener: id, hit count and byte size. */
async function rowsFor(text: string) {
  const { rows } = await pg().query<{
    id: string;
    hit_count: number;
    byte_size: string;
  }>(
    "SELECT id, hit_count, byte_size::text FROM tts_first_line_cache WHERE normalized_text=$1",
    [openerKey(text).normalizedText],
  );
  return rows;
}

/** Every manifest row (full timestamp precision) and every R2 object. */
async function cacheState(): Promise<string> {
  const { rows } = await pg().query<{ row: string }>(
    "SELECT row_to_json(t)::text AS row FROM tts_first_line_cache t ORDER BY key_hash, scope",
  );
  const objects = [...blobs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, blob]) => [
      key,
      Buffer.from(blob.bytes).toString("hex"),
      blob.contentType,
    ]);
  return JSON.stringify({ rows: rows.map(({ row }) => row), objects });
}

/**
 * Watches the cache for `ms` so background work from a finished request can
 * land, and returns the first state that differs from `expected`.
 */
async function cacheStateOver(ms: number, expected: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = await cacheState();
    if (state !== expected) return state;
    await sleep(10);
  }
  return expected;
}

function post(text: string) {
  return app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `cache-${randomUUID()}`,
      },
      body: JSON.stringify({ text }),
    },
    { NODE_ENV: "test" },
  );
}

const at = (mark: string) => {
  expect(events).toContain(mark);
  return events.indexOf(mark);
};

test("a moderation-refused request leaves the real cache byte-identical", async () => {
  await seedOpener("Got it.");
  const orphan = await seedOpener("No problem.");
  blobs.delete(orphan.blobKey);
  const before = await cacheState();

  // The verdict arrives after the cache has been read.
  gates.moderation = async () => {
    await sleep(50);
    events.push("moderation:end");
    throw new ApiError(400, "validation_error", "Content failed safety review");
  };
  for (const text of ["Got it.", "No problem."]) {
    events.length = 0;
    const refused = await post(text);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("X-TTS-Cache")).toBeNull();
    expect(await refused.json()).toMatchObject({
      error: "Content failed safety review",
    });
    // The lookup did run beside moderation; it only read.
    expect(at("r2:get")).toBeLessThan(at("moderation:end"));
    // A refused request never reaches the price, so it hydrates no pricing.
    expect(events).not.toContain("price:start");
    expect(events).not.toContain("admission");
    expect(events).not.toContain("synthesis");
  }

  // Neither the hit (hit count, LRU touch) nor the orphan (row drop) changed.
  expect(await cacheStateOver(300, before)).toBe(before);
});

test("the cache read overlaps moderation; bookkeeping waits for the verdict and a hit never reads the price", async () => {
  const { bytes } = await seedOpener("Sure thing.");
  const before = await cacheState();
  let atVerdict = "";
  gates.moderation = async () => {
    await sleep(60);
    atVerdict = await cacheState();
    events.push("moderation:end");
    return {};
  };

  const served = await post("Sure thing.");
  expect(served.status).toBe(200);
  expect(served.headers.get("X-TTS-Cache")).toBe("hit; first-sentence");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

  // The R2 read was in flight before the verdict; nothing was written by then.
  expect(at("r2:get")).toBeLessThan(at("moderation:end"));
  expect(atVerdict).toBe(before);
  // The hit was confirmed against the row after the verdict and before the
  // response. A hit is free: no price read, no admission, no synthesis.
  expect((await rowsFor("Sure thing.")).map((row) => row.hit_count)).toEqual([
    1,
  ]);
  expect(events).not.toContain("price:start");
  expect(events).not.toContain("admission");
  expect(events).not.toContain("synthesis");
});

test("an orphan row is dropped only after moderation passes", async () => {
  const orphan = await seedOpener("All set.");
  blobs.delete(orphan.blobKey);
  const before = await cacheState();
  let atVerdict = "";
  gates.moderation = async () => {
    await sleep(40);
    atVerdict = await cacheState();
    events.push("moderation:end");
    return {};
  };
  // Stop at the price read so the request ends before paid admission.
  gates.price = async () => {
    throw new AiPricingCacheWarmingError();
  };

  const warming = await post("All set.");
  expect(warming.status).toBe(503);
  expect(atVerdict).toBe(before);
  const { rows } = await pg().query(
    "SELECT id FROM tts_first_line_cache WHERE blob_key=$1",
    [orphan.blobKey],
  );
  expect(rows).toEqual([]);
  // The price is read only after the verdict and the miss.
  expect(at("price:start")).toBeGreaterThan(at("moderation:end"));
  expect(events).not.toContain("admission");
  expect(events).not.toContain("synthesis");
});

/** Holds moderation until the request has read R2, runs `during`, then passes. */
function moderationAfterPeek(during: () => Promise<void>, peeks = 1) {
  return async () => {
    await until(
      () => events.filter((event) => event === "r2:get").length >= peeks,
    );
    await during();
    events.push("moderation:end");
    return {};
  };
}

test("an orphan repaired by put() while moderation is pending survives and is served", async () => {
  const text = "Right away.";
  const orphan = await seedOpener(text);
  blobs.delete(orphan.blobKey);
  const repaired = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x7a, 0x7a]);
  // The request reads the orphan, then another request's real put() repairs
  // the same row (same id, blob back) before the verdict arrives.
  gates.moderation = moderationAfterPeek(async () => {
    expect(blobs.has(orphan.blobKey)).toBe(false);
    await seedOpener(text, repaired);
    events.push("repaired");
  });

  const served = await post(text);
  expect(served.status).toBe(200);
  expect(served.headers.get("X-TTS-Cache")).toBe("hit; first-sentence");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(repaired);
  expect(at("r2:get")).toBeLessThan(at("repaired"));

  // The repaired row was not deleted by the earlier orphan read.
  expect(blobs.get(orphan.blobKey)?.bytes).toEqual(repaired);
  const deadline = Date.now() + 1_000;
  let rows = await rowsFor(text);
  while (rows[0]?.hit_count !== 1 && Date.now() < deadline) {
    await sleep(10);
    rows = await rowsFor(text);
  }
  expect(rows).toEqual([
    { id: orphan.id, hit_count: 1, byte_size: String(repaired.length) },
  ]);
  expect(events).not.toContain("price:start");
  expect(events).not.toContain("admission");
  expect(events).not.toContain("synthesis");
});

test("a hit rewritten by put() while moderation is pending serves the new bytes", async () => {
  const text = "On my way.";
  const seeded = await seedOpener(text);
  const rewritten = new Uint8Array([0x49, 0x44, 0x33, 0x04, 1, 2, 3, 4]);
  gates.moderation = moderationAfterPeek(async () => {
    await seedOpener(text, rewritten);
  });

  const served = await post(text);
  expect(served.status).toBe(200);
  expect(served.headers.get("X-TTS-Cache")).toBe("hit; first-sentence");
  // Not the bytes the earlier read prefetched.
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(rewritten);
  expect((await rowsFor(text)).map((row) => row.id)).toEqual([seeded.id]);
  expect(events).not.toContain("price:start");
});

test("concurrent hits on one row each count", async () => {
  const text = "Of course.";
  await seedOpener(text);
  // Both requests read the row (hit count 0) before either verdict arrives.
  gates.moderation = moderationAfterPeek(async () => undefined, 2);

  const responses = await Promise.all([post(text), post(text)]);
  for (const served of responses) {
    expect(served.status).toBe(200);
    expect(served.headers.get("X-TTS-Cache")).toBe("hit; first-sentence");
  }
  expect((await rowsFor(text)).map((row) => row.hit_count)).toEqual([2]);
});

test("a hit evicted while moderation is pending is not served from the earlier read", async () => {
  const text = "Will do.";
  await seedOpener(text);
  // Real eviction (row, then blob) after the request has read both.
  gates.moderation = moderationAfterPeek(async () => {
    await new CloudFirstLineCacheService({ maxBytesPerScope: 0 }).maybeEvict(
      "global",
    );
    expect(await rowsFor(text)).toEqual([]);
  });
  // Stop at the price read so the request ends before paid admission.
  gates.price = async () => {
    throw new AiPricingCacheWarmingError();
  };

  const missed = await post(text);
  expect(missed.status).toBe(503);
  expect(missed.headers.get("X-TTS-Cache")).toBeNull();
  // The evicted entry was a miss: priced after the verdict, nothing restored.
  expect(at("price:start")).toBeGreaterThan(at("moderation:end"));
  expect(await rowsFor(text)).toEqual([]);
  expect(events).not.toContain("admission");
  expect(events).not.toContain("synthesis");
});
