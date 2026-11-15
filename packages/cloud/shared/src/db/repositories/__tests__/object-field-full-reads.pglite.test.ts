/** Real repository reads over canonical SQL columns and a controlled R2 boundary. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../client");
const { conversationMessages } = await import("../../schemas/conversations");
const { generations } = await import("../../schemas/generations");
const { agentEvents } = await import("../../schemas/agent-events");
const seo = await import("../../schemas/seo");
const { conversationsRepository } = await import("../conversations");
const { generationsRepository } = await import("../generations");
const { agentEventsRepository } = await import("../agent-events");
const { seoRequestsRepository } = await import("../seo-requests");
const { seoProviderCallsRepository } = await import("../seo-provider-calls");
const { seoArtifactsRepository } = await import("../seo-artifacts");
const { setRuntimeR2Bucket } = await import("../../../lib/storage/r2-runtime-binding");
const id = randomUUID();
const organizationId = randomUUID();
const parentId = randomUUID();
const fullText = "Original full context 😀 and retained source. ".repeat(400);
const fullJson = { text: fullText, references: [{ id: "original", exact: true }] };
const fetched: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected a repository record");
  }
  return value;
}
function first(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Expected one repository row");
  return record(value[0]);
}

type Context = {
  name: string;
  fields: Array<readonly [string, "text" | "json"]>;
  replace(fields: Record<string, unknown>): Promise<void>;
  read(): Promise<Record<string, unknown>>;
};
const contexts: Context[] = [
  {
    name: "conversation",
    fields: [
      ["content", "text"],
      ["api_request", "json"],
      ["api_response", "json"],
    ],
    replace: async (fields: Record<string, unknown>) => {
      await dbWrite.delete(conversationMessages);
      await dbWrite.insert(conversationMessages).values({
        id,
        conversation_id: parentId,
        role: "user",
        content: "preview",
        sequence_number: 1,
        ...fields,
      });
    },
    read: async () => first(await conversationsRepository.getMessages(parentId)),
  },
  {
    name: "generation",
    fields: [
      ["prompt", "text"],
      ["negative_prompt", "text"],
      ["result", "json"],
      ["content", "text"],
    ],
    replace: async (fields: Record<string, unknown>) => {
      await dbWrite.delete(generations);
      await dbWrite.insert(generations).values({
        id,
        organization_id: organizationId,
        type: "image",
        model: "test",
        provider: "test",
        prompt: "preview",
        ...fields,
      });
    },
    read: async () => record(await generationsRepository.findById(id)),
  },
  {
    name: "agent event",
    fields: [
      ["message", "text"],
      ["metadata", "json"],
    ],
    replace: async (fields: Record<string, unknown>) => {
      await dbWrite.delete(agentEvents);
      await dbWrite.insert(agentEvents).values({
        id,
        organization_id: organizationId,
        agent_id: parentId,
        event_type: "system",
        message: "preview",
        ...fields,
      });
    },
    read: async () => record(await agentEventsRepository.findById(id)),
  },
  {
    name: "SEO request",
    fields: [["prompt_context", "text"]],
    replace: async (fields: Record<string, unknown>) => {
      await dbWrite.delete(seo.seoRequests);
      await dbWrite.insert(seo.seoRequests).values({
        id,
        organization_id: organizationId,
        type: "keyword_research",
        ...fields,
      });
    },
    read: async () => record(await seoRequestsRepository.findById(id)),
  },
  {
    name: "SEO provider call",
    fields: [
      ["request_payload", "json"],
      ["response_payload", "json"],
    ],
    replace: async (fields: Record<string, unknown>) => {
      await dbWrite.delete(seo.seoProviderCalls);
      await dbWrite.insert(seo.seoProviderCalls).values({
        id,
        request_id: parentId,
        provider: "dataforseo",
        operation: "test",
        ...fields,
      });
    },
    read: async () => first(await seoProviderCallsRepository.listByRequest(parentId)),
  },
  {
    name: "SEO artifact",
    fields: [["data", "json"]],
    replace: async (fields: Record<string, unknown>) => {
      await dbWrite.delete(seo.seoArtifacts);
      await dbWrite.insert(seo.seoArtifacts).values({
        id,
        request_id: parentId,
        type: "keywords",
        provider: "dataforseo",
        data: {},
        ...fields,
      });
    },
    read: async () => first(await seoArtifactsRepository.listByRequest(parentId)),
  },
];

beforeAll(async () => {
  const schema = { conversationMessages, generations, agentEvents, ...seo };
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  // Keep exact owning columns/defaults/enums. Cross-domain FK behavior belongs
  // to separate authorization tests, rather than this complete-read boundary.
  for (const statement of statements) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await dbWrite.execute(statement);
  }
}, 120_000);
beforeEach(() => {
  fetched.length = 0;
  setRuntimeR2Bucket({
    get: async (key) => {
      fetched.push(key);
      if (key === "missing") return null;
      if (key === "failure") throw new Error("controlled provider failure");
      return {
        text: async () => {
          if (key === "full-text") return fullText;
          if (key === "full-json") return JSON.stringify(fullJson);
          if (key === "empty") return "";
          return "{invalid";
        },
      };
    },
    put: async () => {
      throw new Error("A read must not upload an object");
    },
    delete: async () => {
      throw new Error("A read must not delete an object");
    },
  });
});
afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

for (const context of contexts) {
  for (const [field, format] of context.fields) {
    test(`${context.name} ${field} full read requires its complete object`, async () => {
      const storage = `${field}_storage`;
      const key = `${field}_key`;
      const preview = format === "text" ? "preview" : { preview: true };
      await context.replace({ [field]: preview, [storage]: "r2", [key]: null });
      await expect(context.read()).rejects.toMatchObject({
        code: "OBJECT_STORAGE_FIELD_POINTER_INVALID",
      });
      await context.replace({ [field]: preview, [storage]: "r2", [key]: "missing" });
      await expect(context.read()).rejects.toMatchObject({
        code: "OBJECT_STORAGE_FIELD_UNAVAILABLE",
      });
      await context.replace({
        [field]: preview,
        [storage]: "r2",
        [key]: format === "text" ? "full-text" : "full-json",
      });
      expect((await context.read())[field]).toEqual(format === "text" ? fullText : fullJson);
    });
  }
}

test("full reads reject invalid pointer states and preserve provider failures", async () => {
  const context = contexts[0];
  if (!context) throw new Error("Missing conversation test context");
  for (const pointer of [
    { content_storage: "unknown", content_key: null },
    { content_storage: "inline", content_key: "old-object" },
  ]) {
    await context.replace(pointer);
    await expect(context.read()).rejects.toMatchObject({
      code: "OBJECT_STORAGE_FIELD_POINTER_INVALID",
    });
  }
  await context.replace({ content_storage: "r2", content_key: "failure" });
  await expect(context.read()).rejects.toMatchObject({
    code: "OBJECT_STORAGE_FIELD_UNAVAILABLE",
    cause: { message: "controlled provider failure" },
  });
});

test("empty full text is valid while malformed object JSON fails explicitly", async () => {
  const context = contexts[0];
  if (!context) throw new Error("Missing conversation test context");
  await context.replace({ content_storage: "r2", content_key: "empty" });
  expect((await context.read()).content).toBe("");
  for (const key of ["empty", "malformed"]) {
    await context.replace({ api_request_storage: "r2", api_request_key: key });
    await expect(context.read()).rejects.toMatchObject({
      code: "OBJECT_STORAGE_FIELD_JSON_INVALID",
    });
  }
});

test("generation summary remains an explicit preview without object fetches", async () => {
  const context = contexts[1];
  if (!context) throw new Error("Missing generation test context");
  await context.replace({
    prompt_storage: "r2",
    prompt_key: "missing",
    result_storage: "r2",
    result_key: "missing",
  });
  const summaries = await generationsRepository.listByOrganizationSummary(organizationId);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]?.prompt_preview).toBe("preview");
  expect(summaries[0]?.has_result_payload).toBe(true);
  expect(fetched).toEqual([]);
});
