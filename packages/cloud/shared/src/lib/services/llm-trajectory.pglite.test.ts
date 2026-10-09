/**
 * Recorded model calls on real PGlite: bodies are encrypted with row/column
 * AAD, payloads go only to the dedicated private store (never the public
 * general BLOB bucket), legacy plaintext rows still read, and the retention
 * purge removes expired rows together with their payload objects.
 *
 * Field encryption is replaced by a coordinate-checking fake: the AES-GCM
 * envelope itself is covered by field-encryption.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
for (const name of [
  "STORAGE_TRAJECTORIES_BUCKET",
  "R2_TRAJECTORIES_BUCKET",
  "STORAGE_BLOB_DEFAULT_BUCKET",
  "R2_BLOB_DEFAULT_BUCKET",
  "LLM_TRAJECTORY_RETENTION_DAYS",
]) {
  delete process.env[name];
}

interface Coords {
  table: string;
  rowId: string;
  column: string;
}

const encryptCalls: Array<{ organizationId: string; coords?: Coords }> = [];

mock.module("./field-encryption", () => ({
  fieldEncryption: {
    isEncrypted: (value: string | null | undefined) => Boolean(value?.startsWith("enc:v1:")),
    encrypt: async (organizationId: string, plaintext: string, coords?: Coords) => {
      encryptCalls.push({ organizationId, coords });
      const envelope = JSON.stringify({ organizationId, coords, plaintext });
      return `enc:v1:${Buffer.from(envelope).toString("base64")}`;
    },
    decrypt: async (value: string, coords?: Coords) => {
      const envelope = JSON.parse(
        Buffer.from(value.slice("enc:v1:".length), "base64").toString("utf8"),
      ) as { coords?: Coords; plaintext: string };
      if (JSON.stringify(envelope.coords) !== JSON.stringify(coords)) {
        throw new Error("Unsupported state or unable to authenticate data");
      }
      return envelope.plaintext;
    },
  },
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
  "../../db/client"
);
const { runWithCloudBindingsAsync } = await import("../runtime/cloud-bindings");
const { setRuntimeR2Bucket } = await import("../storage/r2-runtime-binding");
const { llmTrajectoryService } = await import("./llm-trajectory");
const { purgeExpiredLlmTrajectories } = await import("./llm-trajectory-purge");

const ORG_ID = "00000000-0000-4000-8000-00000000c001";

class MemoryBucket {
  readonly objects = new Map<string, string>();
  puts = 0;

  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async put(key: string, value: unknown) {
    this.puts += 1;
    this.objects.set(key, String(value));
    return {};
  }

  async delete(key: string) {
    this.objects.delete(key);
    return {};
  }
}

let generalBlob: MemoryBucket;
let privateBlob: MemoryBucket;

function withPrivateStore<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCloudBindingsAsync({ TRAJECTORY_BLOB: privateBlob }, fn);
}

async function rows() {
  const result = await getPgliteClientForTests().query<Record<string, string | null>>(
    "SELECT id, system_prompt, user_prompt, response_text, trajectory_payload_storage, trajectory_payload_key FROM llm_trajectories ORDER BY created_at",
  );
  return result.rows;
}

const CALL = {
  organizationId: ORG_ID,
  model: "gpt-oss-120b",
  provider: "cerebras",
  purpose: "response",
  systemPrompt: "You are Eliza.",
  userPrompt: "What is my diagnosis?",
  responseText: "I can't tell you that.",
};

beforeAll(async () => {
  await getPgliteClientForTests().exec(`
    CREATE TABLE llm_trajectories (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid, api_key_id uuid,
      model text NOT NULL, provider text NOT NULL, purpose text, request_id text,
      system_prompt text, user_prompt text, response_text text,
      trajectory_payload_storage text NOT NULL DEFAULT 'inline', trajectory_payload_key text,
      input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
      total_tokens integer NOT NULL DEFAULT 0, input_cost numeric(12,6) DEFAULT 0,
      output_cost numeric(12,6) DEFAULT 0, total_cost numeric(12,6) DEFAULT 0,
      latency_ms integer, is_successful boolean NOT NULL DEFAULT true, error_message text,
      metadata jsonb NOT NULL DEFAULT '{}', created_at timestamp NOT NULL DEFAULT now()
    );
  `);
}, 120_000);

beforeEach(async () => {
  encryptCalls.length = 0;
  generalBlob = new MemoryBucket();
  privateBlob = new MemoryBucket();
  // The Worker always registers the general BLOB bucket; it must stay unused.
  setRuntimeR2Bucket(generalBlob);
  await getPgliteClientForTests().exec("DELETE FROM llm_trajectories");
});

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

describe("llmTrajectoryService.logCall", () => {
  test("without a private store, bodies are encrypted inline and BLOB is never written", async () => {
    await llmTrajectoryService.logCall(CALL);

    expect(generalBlob.puts).toBe(0);
    const [row] = await rows();
    expect(row.trajectory_payload_storage).toBe("inline");
    expect(row.trajectory_payload_key).toBeNull();
    for (const column of ["system_prompt", "user_prompt", "response_text"]) {
      expect(row[column]?.startsWith("enc:v1:")).toBe(true);
    }
    expect(JSON.stringify(row)).not.toContain("diagnosis");
    expect(encryptCalls.map((call) => call.coords)).toEqual(
      ["system_prompt", "user_prompt", "response_text"].map((column) => ({
        table: "llm_trajectories",
        rowId: row.id as string,
        column,
      })),
    );
    expect(encryptCalls.every((call) => call.organizationId === ORG_ID)).toBe(true);

    const listed = await llmTrajectoryService.listByOrganization(ORG_ID);
    expect(listed.trajectories[0]).toMatchObject({
      system_prompt: CALL.systemPrompt,
      user_prompt: CALL.userPrompt,
      response_text: CALL.responseText,
    });
  });

  test("with the private binding, encrypted payloads go only to TRAJECTORY_BLOB", async () => {
    await withPrivateStore(() => llmTrajectoryService.logCall(CALL));

    expect(generalBlob.puts).toBe(0);
    expect(privateBlob.puts).toBe(1);
    const [row] = await rows();
    expect(row.trajectory_payload_storage).toBe("private_object");
    expect(row.user_prompt).toBeNull();
    const stored = privateBlob.objects.get(row.trajectory_payload_key as string) as string;
    expect(stored).not.toContain("diagnosis");

    const jsonl = await withPrivateStore(() => llmTrajectoryService.exportAsTrainingJSONL(ORG_ID));
    expect(JSON.parse(jsonl)).toEqual({
      messages: [
        { role: "system", content: CALL.systemPrompt },
        { role: "user", content: CALL.userPrompt },
        { role: "model", content: CALL.responseText },
      ],
    });
  });

  test("a private-store row without the private store configured fails loudly", async () => {
    await withPrivateStore(() => llmTrajectoryService.logCall(CALL));
    await expect(llmTrajectoryService.listByOrganization(ORG_ID)).rejects.toMatchObject({
      code: "TRAJECTORY_STORAGE_UNAVAILABLE",
    });
  });

  test("missing payloads fail listing and export instead of returning incomplete training data", async () => {
    await withPrivateStore(() => llmTrajectoryService.logCall(CALL));
    const [row] = await rows();
    privateBlob.objects.delete(row.trajectory_payload_key as string);
    await expect(
      withPrivateStore(() => llmTrajectoryService.listByOrganization(ORG_ID)),
    ).rejects.toMatchObject({ code: "TRAJECTORY_PAYLOAD_MISSING" });
    await expect(
      withPrivateStore(() => llmTrajectoryService.exportAsTrainingJSONL(ORG_ID)),
    ).rejects.toMatchObject({ code: "TRAJECTORY_PAYLOAD_MISSING" });
    await getPgliteClientForTests().exec(
      "UPDATE llm_trajectories SET trajectory_payload_key = NULL",
    );
    await expect(
      withPrivateStore(() => llmTrajectoryService.exportAsTrainingJSONL(ORG_ID)),
    ).rejects.toMatchObject({ code: "TRAJECTORY_PAYLOAD_INVALID" });
  });

  test("a ciphertext moved to another column does not decrypt", async () => {
    await llmTrajectoryService.logCall(CALL);
    await getPgliteClientForTests().exec("UPDATE llm_trajectories SET response_text = user_prompt");
    await expect(llmTrajectoryService.listByOrganization(ORG_ID)).rejects.toThrow(
      "unable to authenticate",
    );
  });

  test("legacy plaintext rows (inline and general-bucket) still read", async () => {
    const inlineId = "00000000-0000-4000-8000-00000000d001";
    const legacyId = "00000000-0000-4000-8000-00000000d002";
    const legacyKey = `${ORG_ID}/2026-01-01/${legacyId}.json`;
    generalBlob.objects.set(
      legacyKey,
      JSON.stringify({ system_prompt: null, user_prompt: "old q", response_text: "old a" }),
    );
    await getPgliteClientForTests().exec(`
      INSERT INTO llm_trajectories (id, organization_id, model, provider, user_prompt, response_text, created_at)
        VALUES ('${inlineId}', '${ORG_ID}', 'm', 'p', 'plain q', 'plain a', now() - interval '1 minute');
      INSERT INTO llm_trajectories (id, organization_id, model, provider, trajectory_payload_storage, trajectory_payload_key)
        VALUES ('${legacyId}', '${ORG_ID}', 'm', 'p', 'r2', '${legacyKey}');
    `);
    const listed = await llmTrajectoryService.listByOrganization(ORG_ID);
    expect(listed.trajectories.map((row) => [row.id, row.user_prompt, row.response_text])).toEqual([
      [legacyId, "old q", "old a"],
      [inlineId, "plain q", "plain a"],
    ]);
  });
});

describe("purgeExpiredLlmTrajectories", () => {
  test("deletes expired rows and their payload objects in every store, keeps recent rows", async () => {
    await withPrivateStore(() => llmTrajectoryService.logCall(CALL));
    const [recent] = await rows();

    const oldPrivateId = "00000000-0000-4000-8000-00000000e001";
    const oldLegacyId = "00000000-0000-4000-8000-00000000e002";
    const oldInlineId = "00000000-0000-4000-8000-00000000e003";
    privateBlob.objects.set("old/private.json", "{}");
    generalBlob.objects.set("old/legacy.json", "{}");
    await getPgliteClientForTests().exec(`
      INSERT INTO llm_trajectories (id, organization_id, model, provider, trajectory_payload_storage, trajectory_payload_key, created_at) VALUES
        ('${oldPrivateId}', '${ORG_ID}', 'm', 'p', 'private_object', 'old/private.json', now() - interval '91 days'),
        ('${oldLegacyId}', '${ORG_ID}', 'm', 'p', 'r2', 'old/legacy.json', now() - interval '91 days'),
        ('${oldInlineId}', '${ORG_ID}', 'm', 'p', 'inline', NULL, now() - interval '91 days');
    `);

    const result = await withPrivateStore(() => purgeExpiredLlmTrajectories());

    expect(result).toMatchObject({
      retentionDays: 90,
      deletedRows: 3,
      deletedObjects: 2,
      more: false,
    });
    expect(privateBlob.objects.has("old/private.json")).toBe(false);
    expect(generalBlob.objects.has("old/legacy.json")).toBe(false);
    expect((await rows()).map((row) => row.id)).toEqual([recent.id]);
    expect(privateBlob.objects.has(recent.trajectory_payload_key as string)).toBe(true);
  });

  test("keeps the row when its payload object cannot be deleted", async () => {
    const id = "00000000-0000-4000-8000-00000000e004";
    await getPgliteClientForTests().exec(`
      INSERT INTO llm_trajectories (id, organization_id, model, provider, trajectory_payload_storage, trajectory_payload_key, created_at)
        VALUES ('${id}', '${ORG_ID}', 'm', 'p', 'private_object', 'old/unreachable.json', now() - interval '10 days');
    `);
    // No private store registered: the purge must fail rather than orphan the object.
    await expect(purgeExpiredLlmTrajectories({ retentionDays: 1 })).rejects.toMatchObject({
      code: "TRAJECTORY_STORAGE_UNAVAILABLE",
    });
    expect((await rows()).map((row) => row.id)).toEqual([id]);
  });
});
