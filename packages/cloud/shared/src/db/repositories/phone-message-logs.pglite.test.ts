/** Proves typed phone-message writes and tenant-scoped reads against a real PGlite database. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { isPhoneLosslessJsonNumber } from "../../lib/services/phone-lossless-json";
import { ObjectNamespaces } from "../../lib/storage/object-namespace";
import { buildObjectFieldKey } from "../../lib/storage/object-store";
import {
  type RuntimeR2Bucket,
  type RuntimeR2PutOptions,
  setRuntimeR2Bucket,
} from "../../lib/storage/r2-runtime-binding";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORGANIZATION_ID = "51111111-1111-4111-8111-111111111111";
const OTHER_ORGANIZATION_ID = "52222222-2222-4222-8222-222222222222";
const PHONE_NUMBER_ID = "53333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "54444444-4444-4444-8444-444444444444";
const CREATED_AT = new Date("2026-08-20T12:34:56.000Z");

let dbWrite: typeof import("../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: typeof import("./phone-message-logs").phoneMessageLogsRepository;

function memoryBucket(
  objects: Map<string, string>,
  hooks: { beforePut?: (key: string) => Promise<void>; onGet?: () => void } = {},
): RuntimeR2Bucket {
  return {
    async get(key) {
      hooks.onGet?.();
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            async text() {
              return value;
            },
          };
    },
    async put(key, value, options?: RuntimeR2PutOptions) {
      await hooks.beforePut?.(key);
      if (typeof value !== "string") throw new Error("Expected a text test payload");
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, value);
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

function forceObjectStorage(bucket: RuntimeR2Bucket): void {
  process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
  process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = "20";
  process.env.SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES = "0";
  setRuntimeR2Bucket(bucket);
}

function versionedKey(
  field: "message_body" | "media_urls" | "agent_response" | "metadata",
  extension: "json" | "txt",
  organizationId = ORGANIZATION_ID,
): string {
  return buildObjectFieldKey({
    namespace: ObjectNamespaces.PhoneMessagePayloads,
    organizationId,
    objectId: MESSAGE_ID,
    field,
    createdAt: CREATED_AT,
    extension,
    version: "56666666-6666-4666-8666-666666666666",
  });
}

function legacyTextKey(field: "media_urls" | "metadata"): string {
  return buildObjectFieldKey({
    namespace: ObjectNamespaces.PhoneMessagePayloads,
    organizationId: ORGANIZATION_ID,
    objectId: MESSAGE_ID,
    field,
    createdAt: CREATED_AT,
    extension: "txt",
  });
}

function createBarrier(parties: number): {
  arrive: () => Promise<void>;
  release: () => Promise<void>;
} {
  let arrivals = 0;
  let releaseBarrier!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let allArrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    allArrived = resolve;
  });
  return {
    async arrive() {
      arrivals += 1;
      if (arrivals === parties) allArrived();
      await released;
    },
    async release() {
      await reached;
      releaseBarrier();
    },
  };
}

function createPutGate(): {
  block: () => Promise<void>;
  waitUntilBlocked: () => Promise<void>;
  release: () => void;
} {
  let signalBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => {
    signalBlocked = resolve;
  });
  let releasePut!: () => void;
  const released = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  return {
    async block() {
      signalBlocked();
      await released;
    },
    async waitUntilBlocked() {
      await blocked;
    },
    release() {
      releasePut();
    },
  };
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
    "../client"
  ));
  ({ phoneMessageLogsRepository: repository } = await import("./phone-message-logs"));

  await getPgliteClientForTests().exec(`
    CREATE TABLE agent_phone_numbers (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      UNIQUE (id, organization_id)
    );
    CREATE TABLE phone_message_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL DEFAULT '${ORGANIZATION_ID}',
      phone_number_id uuid NOT NULL REFERENCES agent_phone_numbers(id) ON DELETE CASCADE,
      direction text NOT NULL,
      from_number text NOT NULL,
      to_number text NOT NULL,
      message_body text,
      message_body_storage text NOT NULL DEFAULT 'inline',
      message_body_key text,
      message_type text NOT NULL DEFAULT 'sms',
      media_urls jsonb,
      media_urls_storage text NOT NULL DEFAULT 'inline',
      media_urls_key text,
      provider_message_id text,
      status text NOT NULL DEFAULT 'received',
      error_message text,
      agent_response text,
      agent_response_storage text NOT NULL DEFAULT 'inline',
      agent_response_key text,
      response_time_ms text,
      metadata jsonb DEFAULT '{}'::jsonb,
      metadata_storage text NOT NULL DEFAULT 'inline',
      metadata_key text,
      created_at timestamp NOT NULL DEFAULT now(),
      responded_at timestamp,
      CONSTRAINT phone_message_log_media_urls_array_check CHECK (
        media_urls IS NULL OR (
          jsonb_typeof(media_urls) = 'array'
          AND NOT jsonb_path_exists(media_urls, 'strict $[*] ? (@.type() != "string")')
        )
      ),
      CONSTRAINT phone_message_log_metadata_object_check CHECK (
        metadata IS NULL OR jsonb_typeof(metadata) = 'object'
      ),
      CONSTRAINT phone_message_log_phone_owner_fk FOREIGN KEY (
        phone_number_id, organization_id
      ) REFERENCES agent_phone_numbers(id, organization_id) ON DELETE CASCADE
    );
    CREATE FUNCTION enforce_phone_message_log_owner_for_test()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        RAISE EXCEPTION 'phone message tenant is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER phone_message_log_owner_guard_for_test
      BEFORE UPDATE OF organization_id ON phone_message_log
      FOR EACH ROW EXECUTE FUNCTION enforce_phone_message_log_owner_for_test();
  `);
}, TIMEOUT);

beforeEach(async () => {
  setRuntimeR2Bucket(null);
  process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
  await getPgliteClientForTests().exec(`
    DROP TRIGGER IF EXISTS phone_response_fail_once ON phone_message_log;
    DROP FUNCTION IF EXISTS fail_phone_response_once();
    DROP SEQUENCE IF EXISTS phone_response_fail_sequence;
    DELETE FROM phone_message_log;
    DELETE FROM agent_phone_numbers;
  `);
  await dbWrite.execute(sql`
    INSERT INTO agent_phone_numbers (id, organization_id)
    VALUES (${PHONE_NUMBER_ID}, ${ORGANIZATION_ID})
  `);
});

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests?.();
});

describe("PhoneMessageLogsRepository on PGlite", () => {
  test("round-trips inline objects and arrays without serialized JSON strings", async () => {
    const mediaUrls = ["https://media.example/one", "https://media.example/two"];
    const metadata = { provider: "whatsapp", attempt: 3, flags: ["a", "b"] };

    await expect(
      repository.create(
        {
          id: MESSAGE_ID,
          phone_number_id: PHONE_NUMBER_ID,
          direction: "inbound",
          from_number: "+14155550100",
          to_number: "+14155550101",
          message_body: "hello",
          media_urls: mediaUrls,
          metadata,
        },
        ORGANIZATION_ID,
      ),
    ).resolves.toBe(MESSAGE_ID);

    const raw = await getPgliteClientForTests().query<{
      media_urls: unknown;
      metadata: unknown;
      media_type: string;
      metadata_type: string;
      organization_id: string;
    }>(`
      SELECT
        organization_id,
        media_urls,
        metadata,
        pg_typeof(media_urls)::text AS media_type,
        pg_typeof(metadata)::text AS metadata_type
      FROM phone_message_log
      WHERE id = '${MESSAGE_ID}'
    `);
    expect(raw.rows[0]).toEqual({
      organization_id: ORGANIZATION_ID,
      media_urls: mediaUrls,
      metadata,
      media_type: "jsonb",
      metadata_type: "jsonb",
    });

    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(hydrated).toMatchObject({ id: MESSAGE_ID, media_urls: mediaUrls, metadata });
    await expect(
      repository.findHydratedById(OTHER_ORGANIZATION_ID, MESSAGE_ID),
    ).resolves.toBeNull();
  });

  test("hydrates JSONB and R2 numbers outside the JavaScript range without semantic loss", async () => {
    const extremeJson = '{"huge":1e400,"tiny":1e-400,"rounded":9007199254740993}';
    await getPgliteClientForTests().query(
      `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number, metadata, created_at
        ) VALUES ($1, $2, 'inbound', '+14155550100', '+14155550101', $3::jsonb, $4)
      `,
      [MESSAGE_ID, PHONE_NUMBER_ID, extremeJson, CREATED_AT],
    );

    const inline = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    const inlineMetadata = inline?.metadata as Record<string, unknown>;
    expect(isPhoneLosslessJsonNumber(inlineMetadata.huge)).toBe(true);
    expect(isPhoneLosslessJsonNumber(inlineMetadata.tiny)).toBe(true);
    expect(isPhoneLosslessJsonNumber(inlineMetadata.rounded)).toBe(true);
    const inlineComparison = await getPgliteClientForTests().query<{ equal: boolean }>(
      "SELECT metadata = $1::jsonb AS equal FROM phone_message_log WHERE id = $2",
      [JSON.stringify(inlineMetadata), MESSAGE_ID],
    );
    expect(inlineComparison.rows[0]?.equal).toBe(true);

    const key = versionedKey("metadata", "json");
    forceObjectStorage(memoryBucket(new Map([[key, extremeJson]])));
    await getPgliteClientForTests().query(
      "UPDATE phone_message_log SET metadata = '{}'::jsonb, metadata_storage = 'r2', metadata_key = $1 WHERE id = $2",
      [key, MESSAGE_ID],
    );
    const objectBacked = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(JSON.stringify(objectBacked?.metadata)).toBe(extremeJson);
  });

  test("rejects a cross-tenant phone-number owner before inserting the message", async () => {
    await expect(
      repository.create(
        {
          id: MESSAGE_ID,
          phone_number_id: PHONE_NUMBER_ID,
          direction: "inbound",
          from_number: "+14155550100",
          to_number: "+14155550101",
          message_body: "must not be stored",
          metadata: { provider: "whatsapp" },
        },
        OTHER_ORGANIZATION_ID,
      ),
    ).rejects.toMatchObject({ code: "PHONE_MESSAGE_OWNER_NOT_FOUND" });

    const count = await getPgliteClientForTests().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM phone_message_log",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  test("rejects a create when the phone number is reassigned after the initial owner check", async () => {
    const putGate = createPutGate();
    const objects = new Map<string, string>();
    forceObjectStorage(memoryBucket(objects, { beforePut: putGate.block }));

    const create = repository.create(
      {
        id: MESSAGE_ID,
        phone_number_id: PHONE_NUMBER_ID,
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: `blocked-${"x".repeat(128)}`,
        created_at: CREATED_AT,
      },
      ORGANIZATION_ID,
    );

    await putGate.waitUntilBlocked();
    try {
      await getPgliteClientForTests().query(
        "UPDATE agent_phone_numbers SET organization_id = $1 WHERE id = $2",
        [OTHER_ORGANIZATION_ID, PHONE_NUMBER_ID],
      );
    } finally {
      putGate.release();
    }

    await expect(create).rejects.toMatchObject({ code: "PHONE_MESSAGE_OWNER_NOT_FOUND" });
    expect(objects.size).toBe(1);
    const count = await getPgliteClientForTests().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM phone_message_log",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  test("keeps historical message ownership immutable after phone-number reassignment", async () => {
    await repository.create(
      {
        id: MESSAGE_ID,
        phone_number_id: PHONE_NUMBER_ID,
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: "historical owner only",
      },
      ORGANIZATION_ID,
    );

    await expect(
      getPgliteClientForTests().query(
        "UPDATE agent_phone_numbers SET organization_id = $1 WHERE id = $2",
        [OTHER_ORGANIZATION_ID, PHONE_NUMBER_ID],
      ),
    ).rejects.toThrow(/phone_message_log_phone_owner_fk/);
    await expect(
      getPgliteClientForTests().query(
        "UPDATE phone_message_log SET organization_id = $1 WHERE id = $2",
        [OTHER_ORGANIZATION_ID, MESSAGE_ID],
      ),
    ).rejects.toThrow(/phone message tenant is immutable/);

    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).resolves.toMatchObject({
      organization_id: ORGANIZATION_ID,
      message_body: "historical owner only",
    });
    await expect(
      repository.findHydratedById(OTHER_ORGANIZATION_ID, MESSAGE_ID),
    ).resolves.toBeNull();
    await expect(
      repository.updateAgentResponse(OTHER_ORGANIZATION_ID, MESSAGE_ID, "forbidden", 10),
    ).rejects.toMatchObject({ code: "PHONE_MESSAGE_NOT_FOUND" });
    await expect(
      repository.updateAgentResponse(ORGANIZATION_ID, MESSAGE_ID, "allowed", 11),
    ).resolves.toBeUndefined();
  });

  test("does not update a message through another tenant", async () => {
    await repository.create(
      {
        id: MESSAGE_ID,
        phone_number_id: PHONE_NUMBER_ID,
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: "unchanged",
      },
      ORGANIZATION_ID,
    );

    await expect(
      repository.updateAgentResponse(OTHER_ORGANIZATION_ID, MESSAGE_ID, "forbidden", 10),
    ).rejects.toMatchObject({ code: "PHONE_MESSAGE_NOT_FOUND" });
    await expect(
      repository.markFailed(OTHER_ORGANIZATION_ID, MESSAGE_ID, "forbidden"),
    ).rejects.toMatchObject({ code: "PHONE_MESSAGE_NOT_FOUND" });

    const result = await getPgliteClientForTests().query<{
      status: string;
      agent_response: string | null;
      error_message: string | null;
    }>(`SELECT status, agent_response, error_message FROM phone_message_log WHERE id = $1`, [
      MESSAGE_ID,
    ]);
    expect(result.rows[0]).toEqual({
      status: "received",
      agent_response: null,
      error_message: null,
    });
  });

  test("database constraints reject wrong top-level and media element types", async () => {
    const insertInvalid = async (id: string, mediaUrls: unknown, metadata: unknown) => {
      await getPgliteClientForTests().query(
        `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number, media_urls, metadata
        ) VALUES (
          $1, $2, 'inbound', '+14155550100', '+14155550101', $3::jsonb, $4::jsonb
        )
        `,
        [id, PHONE_NUMBER_ID, JSON.stringify(mediaUrls), JSON.stringify(metadata)],
      );
    };

    await expect(
      insertInvalid("55555555-5555-4555-8555-555555555551", { not: "array" }, {}),
    ).rejects.toThrow(/phone_message_log_media_urls_array_check/);
    await expect(
      insertInvalid("55555555-5555-4555-8555-555555555552", ["ok", 7], {}),
    ).rejects.toThrow(/phone_message_log_media_urls_array_check/);
    await expect(
      insertInvalid("55555555-5555-4555-8555-555555555554", [["https://media.example/nested"]], {}),
    ).rejects.toThrow(/phone_message_log_media_urls_array_check/);
    await expect(insertInvalid("55555555-5555-4555-8555-555555555553", [], [])).rejects.toThrow(
      /phone_message_log_metadata_object_check/,
    );

    const count = await getPgliteClientForTests().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM phone_message_log",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  test("offloads every field to immutable versioned keys and hydrates only through the repository", async () => {
    const objects = new Map<string, string>();
    forceObjectStorage(memoryBucket(objects));
    const messageBody = `body-${"x".repeat(256)}`;
    const agentResponse = `response-${"y".repeat(256)}`;
    const mediaUrls = [`https://media.example/${"m".repeat(64)}`];
    const metadata = { trace: "z".repeat(256), attempt: 2 };

    await repository.create(
      {
        id: MESSAGE_ID.toUpperCase(),
        phone_number_id: PHONE_NUMBER_ID.toUpperCase(),
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: messageBody,
        media_urls: mediaUrls,
        agent_response: agentResponse,
        metadata,
        created_at: CREATED_AT,
      },
      ORGANIZATION_ID.toUpperCase(),
    );

    expect(objects.size).toBe(4);
    for (const key of objects.keys()) {
      expect(key).toContain(`/${ORGANIZATION_ID}/2026-08-20/${MESSAGE_ID}/`);
      expect(key).toMatch(
        /\.(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:json|txt)$/,
      );
      expect(key).not.toMatch(/[A-F]/);
    }

    const hydrated = await repository.findHydratedById(
      ORGANIZATION_ID.toUpperCase(),
      MESSAGE_ID.toUpperCase(),
    );
    expect(hydrated).toMatchObject({
      message_body: messageBody,
      media_urls: mediaUrls,
      agent_response: agentResponse,
      metadata,
    });
  });

  test("a pre-existing object pointer does not skip validation or offload of sibling fields", async () => {
    const messageBody = `existing-${"b".repeat(128)}`;
    const messageBodyKey = versionedKey("message_body", "txt");
    const objects = new Map([[messageBodyKey, messageBody]]);
    forceObjectStorage(memoryBucket(objects));
    const mediaUrls = [`https://media.example/${"m".repeat(64)}`];
    const agentResponse = `response-${"r".repeat(128)}`;
    const metadata = { trace: "t".repeat(128) };

    await repository.create(
      {
        id: MESSAGE_ID,
        phone_number_id: PHONE_NUMBER_ID,
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: "",
        message_body_storage: "r2",
        message_body_key: messageBodyKey,
        media_urls: mediaUrls,
        agent_response: agentResponse,
        metadata,
        created_at: CREATED_AT,
      },
      ORGANIZATION_ID,
    );

    expect(objects.size).toBe(4);
    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(hydrated).toMatchObject({
      message_body: messageBody,
      media_urls: mediaUrls,
      agent_response: agentResponse,
      metadata,
    });
  });

  test("hydrates legacy JSON payloads written behind deterministic text pointers", async () => {
    const mediaUrls = ["https://media.example/legacy"];
    const metadata = { provider: "legacy", attempt: 1 };
    const mediaKey = legacyTextKey("media_urls");
    const metadataKey = legacyTextKey("metadata");
    forceObjectStorage(
      memoryBucket(
        new Map([
          [mediaKey, JSON.stringify(mediaUrls)],
          [metadataKey, JSON.stringify(metadata)],
        ]),
      ),
    );

    await getPgliteClientForTests().query(
      `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number,
          media_urls, media_urls_storage, media_urls_key,
          metadata, metadata_storage, metadata_key, created_at
        ) VALUES (
          $1, $2, 'inbound', '+14155550100', '+14155550101',
          '[]'::jsonb, 'r2', $3,
          '{}'::jsonb, 'r2', $4, $5
        )
      `,
      [MESSAGE_ID, PHONE_NUMBER_ID, mediaKey, metadataKey, CREATED_AT],
    );

    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).resolves.toMatchObject({
      media_urls: mediaUrls,
      metadata,
    });

    const unauthorizedVersionedTextKey = metadataKey.replace(
      ".txt",
      ".56666666-6666-4666-8666-666666666666.txt",
    );
    await getPgliteClientForTests().query(
      "UPDATE phone_message_log SET metadata_key = $1 WHERE id = $2",
      [unauthorizedVersionedTextKey, MESSAGE_ID],
    );
    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_MESSAGE_POINTER_INVALID",
    });
  });

  test("hydrates mixed inline and object-backed fields independently", async () => {
    const messageBody = `mixed-${"b".repeat(128)}`;
    const messageBodyKey = versionedKey("message_body", "txt");
    const mediaUrls = ["https://media.example/inline"];
    const metadata = { mode: "inline", attempt: 2 };
    let reads = 0;
    forceObjectStorage(
      memoryBucket(new Map([[messageBodyKey, messageBody]]), {
        onGet: () => (reads += 1),
      }),
    );
    await getPgliteClientForTests().query(
      `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number,
          message_body, message_body_storage, message_body_key,
          media_urls, media_urls_storage, media_urls_key,
          agent_response, agent_response_storage, agent_response_key,
          metadata, metadata_storage, metadata_key, created_at
        ) VALUES (
          $1, $2, 'inbound', '+14155550100', '+14155550101',
          '', 'r2', $3,
          $4::jsonb, 'inline', NULL,
          'inline response', 'inline', NULL,
          $5::jsonb, 'inline', NULL, $6
        )
      `,
      [
        MESSAGE_ID,
        PHONE_NUMBER_ID,
        messageBodyKey,
        JSON.stringify(mediaUrls),
        JSON.stringify(metadata),
        CREATED_AT,
      ],
    );

    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);

    expect(hydrated).toMatchObject({
      message_body: messageBody,
      media_urls: mediaUrls,
      agent_response: "inline response",
      metadata,
    });
    expect(reads).toBe(1);
  });

  test("concurrent creates never overwrite an object and the hydrated row equals the SQL winner", async () => {
    const objects = new Map<string, string>();
    const barrier = createBarrier(2);
    forceObjectStorage(memoryBucket(objects, { beforePut: barrier.arrive }));
    const bodies = [`first-${"a".repeat(128)}`, `second-${"b".repeat(128)}`];

    const creates = bodies.map((messageBody) =>
      repository.create(
        {
          id: MESSAGE_ID,
          phone_number_id: PHONE_NUMBER_ID,
          direction: "inbound",
          from_number: "+14155550100",
          to_number: "+14155550101",
          message_body: messageBody,
          created_at: CREATED_AT,
        },
        ORGANIZATION_ID,
      ),
    );
    await barrier.release();
    const settled = await Promise.allSettled(creates);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(objects.size).toBe(2);
    expect(new Set(objects.keys()).size).toBe(2);
    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(hydrated?.message_body).toBe(bodies[winnerIndex]);
  });

  test("concurrent response updates use tenant-scoped CAS and hydrate the winning immutable object", async () => {
    await repository.create(
      {
        id: MESSAGE_ID,
        phone_number_id: PHONE_NUMBER_ID,
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: "initial",
        created_at: CREATED_AT,
      },
      ORGANIZATION_ID,
    );
    const objects = new Map<string, string>();
    const barrier = createBarrier(2);
    forceObjectStorage(memoryBucket(objects, { beforePut: barrier.arrive }));
    const responses = [`first-${"a".repeat(128)}`, `second-${"b".repeat(128)}`];

    const updates = responses.map((response, index) =>
      repository.updateAgentResponse(ORGANIZATION_ID, MESSAGE_ID, response, 100 + index),
    );
    await barrier.release();
    const settled = await Promise.allSettled(updates);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "PHONE_MESSAGE_WRITE_CONFLICT" }),
    });
    expect(objects.size).toBe(2);
    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(hydrated?.agent_response).toBe(responses[winnerIndex]);
  });

  test("a SQL failure after PUT leaves the old pointer authoritative and a retry hydrates its own object", async () => {
    await repository.create(
      {
        id: MESSAGE_ID,
        phone_number_id: PHONE_NUMBER_ID,
        direction: "inbound",
        from_number: "+14155550100",
        to_number: "+14155550101",
        message_body: "initial",
        created_at: CREATED_AT,
      },
      ORGANIZATION_ID,
    );
    const objects = new Map<string, string>();
    forceObjectStorage(memoryBucket(objects));
    await getPgliteClientForTests().exec(`
      CREATE SEQUENCE phone_response_fail_sequence START 1;
      CREATE FUNCTION fail_phone_response_once() RETURNS trigger AS $$
      BEGIN
        IF nextval('phone_response_fail_sequence') = 1 THEN
          RAISE EXCEPTION 'injected response update failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER phone_response_fail_once
        BEFORE UPDATE OF agent_response ON phone_message_log
        FOR EACH ROW EXECUTE FUNCTION fail_phone_response_once();
    `);

    const failedBody = `failed-${"f".repeat(128)}`;
    await expect(
      repository.updateAgentResponse(ORGANIZATION_ID, MESSAGE_ID, failedBody, 101),
    ).rejects.toThrow();
    expect(objects.size).toBe(1);
    const afterFailure = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(afterFailure?.agent_response).toBeNull();

    const retryBody = `retry-${"r".repeat(128)}`;
    await repository.updateAgentResponse(ORGANIZATION_ID, MESSAGE_ID, retryBody, 102);
    expect(objects.size).toBe(2);
    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(hydrated?.agent_response).toBe(retryBody);
  });

  test("rejects a cross-tenant versioned key before reading object storage", async () => {
    let reads = 0;
    forceObjectStorage(memoryBucket(new Map(), { onGet: () => (reads += 1) }));
    const wrongKey = versionedKey("metadata", "json", OTHER_ORGANIZATION_ID);
    await getPgliteClientForTests().query(
      `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number, metadata,
          metadata_storage, metadata_key, created_at
        ) VALUES ($1, $2, 'inbound', '+14155550100', '+14155550101', '{}'::jsonb, 'r2', $3, $4)
      `,
      [MESSAGE_ID, PHONE_NUMBER_ID, wrongKey, CREATED_AT],
    );

    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_MESSAGE_POINTER_INVALID",
    });
    expect(reads).toBe(0);
  });

  test("rejects unavailable or wrong-shaped R2 JSON and preserves valid historical nesting", async () => {
    const key = versionedKey("metadata", "json");
    await getPgliteClientForTests().query(
      `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number, metadata,
          metadata_storage, metadata_key, created_at
        ) VALUES ($1, $2, 'inbound', '+14155550100', '+14155550101', '{}'::jsonb, 'r2', $3, $4)
      `,
      [MESSAGE_ID, PHONE_NUMBER_ID, key, CREATED_AT],
    );

    forceObjectStorage(memoryBucket(new Map()));
    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_MESSAGE_PAYLOAD_UNAVAILABLE",
    });

    forceObjectStorage(memoryBucket(new Map([[key, "null"]])));
    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_STORED_JSON_INVALID",
    });

    forceObjectStorage(memoryBucket(new Map([[key, JSON.stringify([])]])));
    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_STORED_JSON_INVALID",
    });

    const nested = { nested: { preserved: true }, values: [null, { depth: 2 }] };
    forceObjectStorage(memoryBucket(new Map([[key, JSON.stringify(nested)]])));
    const hydrated = await repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID);
    expect(hydrated?.metadata).toEqual(nested);
  });

  test("rejects non-string media elements after strict object hydration", async () => {
    const key = versionedKey("media_urls", "json");
    await getPgliteClientForTests().query(
      `
        INSERT INTO phone_message_log (
          id, phone_number_id, direction, from_number, to_number, media_urls,
          media_urls_storage, media_urls_key, created_at
        ) VALUES ($1, $2, 'inbound', '+14155550100', '+14155550101', '[]'::jsonb, 'r2', $3, $4)
      `,
      [MESSAGE_ID, PHONE_NUMBER_ID, key, CREATED_AT],
    );

    forceObjectStorage(memoryBucket(new Map([[key, "null"]])));
    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_MESSAGE_MEDIA_URLS_INVALID",
    });

    forceObjectStorage(memoryBucket(new Map([[key, JSON.stringify(["ok", 7])]])));
    await expect(repository.findHydratedById(ORGANIZATION_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: "PHONE_MESSAGE_MEDIA_URLS_INVALID",
    });
  });
});
