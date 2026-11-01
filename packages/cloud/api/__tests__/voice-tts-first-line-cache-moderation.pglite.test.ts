/**
 * `POST /api/v1/voice/tts` looks up the first-line cache while content
 * moderation is in flight, and a request that moderation refuses leaves the
 * cache exactly as it found it. The lookup that overlaps moderation only
 * reads; the bookkeeping a lookup owes (hit count, LRU touch, dropping an
 * orphan row) runs only after moderation passes. Real first-line cache
 * service on PGlite with an in-memory R2 bucket; auth, content safety,
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

/** Stores an opener through the real cache; returns its blob key and bytes. */
async function seedOpener(text: string) {
  const snip = firstSentenceSnip(text);
  if (!snip) throw new Error(`not a cacheable opener: ${text}`);
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, text.length]);
  const stored = await getCloudFirstLineCacheService().put({
    ...openerKey(text),
    bytes,
    rawText: snip.raw,
    contentType: "audio/mpeg",
    durationMs: 0,
    wordCount: snip.wordCount,
  });
  if (!stored) throw new Error(`cache refused the seed for: ${text}`);
  const { rows } = await pg().query<{ blob_key: string }>(
    "SELECT blob_key FROM tts_first_line_cache WHERE normalized_text=$1",
    [snip.normalized],
  );
  const blobKey = rows[0]?.blob_key;
  if (!blobKey) throw new Error(`no manifest row for: ${text}`);
  return { blobKey, bytes };
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
    expect(events).not.toContain("admission");
    expect(events).not.toContain("synthesis");
  }

  // Neither the hit (hit count, LRU touch) nor the orphan (row drop) changed.
  expect(await cacheStateOver(300, before)).toBe(before);
});

test("the cache lookup and the price read overlap moderation; cache bookkeeping waits for the verdict", async () => {
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

  // Both reads were in flight before the verdict; nothing was written by then.
  expect(at("r2:get")).toBeLessThan(at("moderation:end"));
  expect(at("price:start")).toBeLessThan(at("moderation:end"));
  expect(atVerdict).toBe(before);
  // The hit's bookkeeping lands after the verdict. A hit is free.
  const hitCount = async () => {
    const { rows } = await pg().query<{ hit_count: number }>(
      "SELECT hit_count FROM tts_first_line_cache WHERE normalized_text=$1",
      [openerKey("Sure thing.").normalizedText],
    );
    return rows[0]?.hit_count;
  };
  const deadline = Date.now() + 1_000;
  while ((await hitCount()) !== 1 && Date.now() < deadline) await sleep(10);
  expect(await hitCount()).toBe(1);
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
  expect(events).not.toContain("admission");
  expect(events).not.toContain("synthesis");
});
