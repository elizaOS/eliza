/** Actual generation writes over canonical SQL columns and a controlled R2 boundary. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = "1";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../client");
const { generations } = await import("../../schemas/generations");
const { generationsRepository } = await import("../generations");
const { setRuntimeR2Bucket } = await import("../../../lib/storage/r2-runtime-binding");
const objects = new Map<string, string>();
const writes: Array<{ key: string; body: string; conditional: boolean }> = [];
const deletes: string[] = [];
let beforeWrite: ((body: string) => Promise<void>) | undefined;
let afterWrite: ((body: string) => Promise<void>) | undefined;
let rejectConditional = false;
const original = "original complete payload 😀 ".repeat(40);
const first = "first writer complete payload 😀 ".repeat(40);
const second = "second writer complete payload 😀 ".repeat(40);

beforeAll(async () => {
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ generations }),
  );
  for (const statement of statements) {
    // Keep owning columns/defaults/indexes; cross-domain authorization is separate.
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await dbWrite.execute(statement);
  }
}, 120_000);
beforeEach(async () => {
  await dbWrite.execute(sql`DROP TRIGGER IF EXISTS reject_generation_update ON generations`);
  await dbWrite.execute(sql`DROP FUNCTION IF EXISTS fail_generation_update()`);
  await dbWrite.delete(generations);
  objects.clear();
  writes.length = 0;
  deletes.length = 0;
  beforeWrite = undefined;
  afterWrite = undefined;
  rejectConditional = false;
  setRuntimeR2Bucket({
    get: async (key) => {
      const body = objects.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    put: async (key, body, options) => {
      if (typeof body !== "string") throw new Error("Expected complete string body");
      const conditional =
        options?.onlyIf instanceof Headers && options.onlyIf.get("if-none-match") === "*";
      writes.push({ key, body, conditional });
      if (conditional && (rejectConditional || objects.has(key))) return null;
      await beforeWrite?.(body);
      objects.set(key, body);
      await afterWrite?.(body);
      return { etag: "fixture", size: new TextEncoder().encode(body).byteLength };
    },
    delete: async (key) => {
      deletes.push(key);
      objects.delete(key);
    },
  });
});
afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

async function create() {
  return generationsRepository.create({
    organization_id: randomUUID(),
    type: "image",
    model: "fixture",
    provider: "fixture",
    prompt: original,
    negative_prompt: `negative ${original}`,
    content: `content ${original}`,
    result: { text: original, sources: ["complete", "retained"] },
  });
}
async function stored(id: string) {
  const [row] = await dbWrite.select().from(generations).where(eq(generations.id, id));
  if (!row) throw new Error("Missing stored generation");
  return row;
}

test("a failed SQL update preserves the old committed pointer and complete object", async () => {
  const row = await create();
  const before = await stored(row.id);
  const priorObjects = new Map(objects);
  await dbWrite.execute(
    sql`CREATE FUNCTION fail_generation_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled SQL failure'; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER reject_generation_update BEFORE UPDATE ON generations FOR EACH ROW EXECUTE FUNCTION fail_generation_update()`,
  );
  await expect(generationsRepository.update(row.id, { prompt: first })).rejects.toMatchObject({
    cause: { code: "P0001" },
  });
  expect(await stored(row.id)).toEqual(before);
  expect((await generationsRepository.findById(row.id))?.prompt).toBe(original);
  for (const [key, body] of priorObjects) expect(objects.get(key)).toBe(body);
  expect(objects.size).toBe(priorObjects.size + 1);
  expect(deletes).toEqual([]);
});

test("parallel prepared writers retain their own bytes through later SQL publication", async () => {
  const row = await create();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  afterWrite = async (body) => {
    if (body === first) {
      started.resolve();
      await release.promise;
    }
  };
  const pending = generationsRepository.update(row.id, { prompt: first });
  try {
    await started.promise;
    expect((await generationsRepository.update(row.id, { prompt: second }))?.prompt).toBe(second);
    release.resolve();
    expect((await pending)?.prompt).toBe(first);
    expect((await generationsRepository.findById(row.id))?.prompt).toBe(first);
    const attempts = writes.filter((write) => write.body === first || write.body === second);
    expect(new Set(attempts.map((write) => write.key)).size).toBe(2);
    expect(attempts.every((write) => write.conditional)).toBe(true);
  } finally {
    release.resolve();
    await pending.catch(() => {});
  }
});

test("all four fields publish new immutable keys without replacing prior payloads", async () => {
  const row = await create();
  const before = await stored(row.id);
  const priorObjects = new Map(objects);
  const result = await generationsRepository.update(row.id, {
    prompt: first,
    negative_prompt: `negative ${first}`,
    content: `content ${first}`,
    result: { text: first, sources: ["new", "complete"] },
  });
  expect(result?.prompt).toBe(first);
  expect(result?.negative_prompt).toBe(`negative ${first}`);
  expect(result?.content).toBe(`content ${first}`);
  expect(result?.result).toEqual({ text: first, sources: ["new", "complete"] });
  const after = await stored(row.id);
  for (const field of ["prompt_key", "negative_prompt_key", "content_key", "result_key"] as const) {
    expect(after[field]).not.toBe(before[field]);
  }
  for (const [key, body] of priorObjects) expect(objects.get(key)).toBe(body);
  expect(writes.every((write) => write.conditional)).toBe(true);
  expect(deletes).toEqual([]);
});

test("an ambiguous PUT leaves SQL authority and prior payloads unchanged", async () => {
  const row = await create();
  const before = await stored(row.id);
  const priorObjects = new Map(objects);
  afterWrite = async (body) => {
    if (body === first) throw new Error("controlled lost PUT response");
  };
  await expect(generationsRepository.update(row.id, { prompt: first })).rejects.toThrow(
    "controlled lost PUT response",
  );
  expect(await stored(row.id)).toEqual(before);
  for (const [key, body] of priorObjects) expect(objects.get(key)).toBe(body);
  expect((await generationsRepository.findById(row.id))?.prompt).toBe(original);
  expect(objects.size).toBe(priorObjects.size + 1);
  expect(deletes).toEqual([]);
});

test("a rejected immutable PUT cannot publish a new pointer", async () => {
  const row = await create();
  const before = await stored(row.id);
  const priorObjects = new Map(objects);
  rejectConditional = true;
  await expect(generationsRepository.update(row.id, { prompt: first })).rejects.toMatchObject({
    code: "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
  });
  expect(await stored(row.id)).toEqual(before);
  expect(objects).toEqual(priorObjects);
  expect(deletes).toEqual([]);
});

test("late PUT settlement after a sibling failure cannot alter committed payloads", async () => {
  const row = await create();
  const before = await stored(row.id);
  const priorObjects = new Map(objects);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  beforeWrite = async (body) => {
    if (body === first) throw new Error("controlled prompt failure");
    if (body.includes('"late":true')) {
      started.resolve();
      await release.promise;
    }
  };
  afterWrite = async (body) => {
    if (body.includes('"late":true')) settled.resolve();
  };
  const pending = generationsRepository.update(row.id, {
    prompt: first,
    result: { late: true, text: first },
  });
  const rejection = expect(pending).rejects.toThrow("controlled prompt failure");
  try {
    await started.promise;
    await rejection;
    expect(await stored(row.id)).toEqual(before);
    release.resolve();
    await settled.promise;
    for (const [key, body] of priorObjects) expect(objects.get(key)).toBe(body);
    expect((await generationsRepository.findById(row.id))?.result).toEqual(row.result);
    expect(objects.size).toBe(priorObjects.size + 1);
    expect(deletes).toEqual([]);
  } finally {
    release.resolve();
    await pending.catch(() => {});
  }
});

test("explicit retained pointer restoration keeps its existing authority", async () => {
  const row = await create();
  const before = await stored(row.id);
  const oldKey = before.prompt_key;
  expect(oldKey).toBeString();
  await generationsRepository.update(row.id, { prompt: first });
  const writeCount = writes.length;
  const restored = await generationsRepository.update(row.id, {
    prompt: before.prompt,
    prompt_storage: "r2",
    prompt_key: oldKey,
  });
  expect(restored?.prompt).toBe(original);
  expect((await stored(row.id)).prompt_key).toBe(oldKey);
  expect(writes).toHaveLength(writeCount);
  expect(deletes).toEqual([]);
});

test("field offload retains complete content above the smaller immutable-helper ceiling", async () => {
  const large = `${"x".repeat(33 * 1024 * 1024)}😀`;
  const row = await generationsRepository.create({
    organization_id: randomUUID(),
    type: "image",
    model: "fixture",
    provider: "fixture",
    prompt: large,
  });
  expect(row.prompt).toBe(large);
  expect((await generationsRepository.findById(row.id))?.prompt).toBe(large);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.conditional).toBe(true);
});
