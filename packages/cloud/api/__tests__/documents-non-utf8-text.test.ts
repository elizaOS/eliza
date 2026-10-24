/**
 * A text document that is not UTF-8 (for example a Windows-1252 notes.txt
 * with "café" and "€") must be refused, not stored with every non-UTF-8 byte
 * turned into U+FFFD. Real submit and upload-file routes; the bucket is in
 * memory, the caller and the document store are mocked.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-1111111111a8";
const USER = "22222222-2222-4222-8222-2222222222a8";
// "café, €100" in Windows-1252.
const CP1252 = new Uint8Array([
  0x63, 0x61, 0x66, 0xe9, 0x2c, 0x20, 0x80, 0x31, 0x30, 0x30,
]);

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: USER,
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: "owner",
  }),
}));

const realWorkerDocuments = {
  ...(await import("../v1/documents/_worker-documents")),
};
const storedText: string[] = [];
mock.module("../v1/documents/_worker-documents", () => ({
  ...realWorkerDocuments,
  resolveDocumentScope: async () => ({ agentId: USER, roomId: USER }),
  createDocumentRecord: async (
    _user: unknown,
    _scope: unknown,
    file: { filename: string; text: string },
  ) => {
    storedText.push(file.text);
    return { id: file.filename };
  },
}));

const { Hono } = await import("hono");
const { default: submitRoute } = await import("../v1/documents/submit/route");
const { default: uploadFileRoute } = await import(
  "../v1/documents/upload-file/route"
);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

beforeEach(() => {
  storedText.length = 0;
});

test("submit refuses a pending text file that is not UTF-8 and deletes its blob", async () => {
  const key = `documents-pre-upload/${USER}/notes.txt`;
  const objects = new Map<string, Uint8Array>([[key, CP1252]]);
  const bucket = {
    async get(name: string) {
      const bytes = objects.get(name);
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async delete(name: string) {
      objects.delete(name);
    },
  };
  const app = new Hono().route("/api/v1/documents/submit", submitRoute);
  const response = await app.request(
    "/api/v1/documents/submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        characterId: "character-1",
        files: [
          {
            blobUrl: `https://blob.example/${key}`,
            filename: "notes.txt",
            contentType: "text/plain",
            size: CP1252.length,
          },
        ],
      }),
    },
    { ...env, BLOB: bucket },
  );
  const body = (await response.json()) as {
    success: boolean;
    results: Array<{ status: string; error?: string }>;
  };

  expect(body.success).toBe(false);
  expect(body.results[0]).toMatchObject({ status: "error" });
  expect(body.results[0]?.error).toContain("is not UTF-8 text");
  expect(storedText).toEqual([]);
  expect(objects.has(key)).toBe(false);
});

test("upload-file refuses a text file that is not UTF-8 and stores nothing", async () => {
  const app = new Hono().route(
    "/api/v1/documents/upload-file",
    uploadFileRoute,
  );
  const form = new FormData();
  form.append("characterId", "character-1");
  form.append("files", new File([CP1252], "notes.txt", { type: "text/plain" }));
  const response = await app.request(
    "/api/v1/documents/upload-file",
    { method: "POST", body: form },
    env,
  );

  expect(response.status).toBe(415);
  expect(((await response.json()) as { error: string }).error).toContain(
    "is not UTF-8 text",
  );
  expect(storedText).toEqual([]);
});

test("a UTF-8 text file is still stored as it is", async () => {
  const app = new Hono().route(
    "/api/v1/documents/upload-file",
    uploadFileRoute,
  );
  const form = new FormData();
  form.append("characterId", "character-1");
  form.append(
    "files",
    new File(["café, €100"], "notes.txt", { type: "text/plain" }),
  );
  const response = await app.request(
    "/api/v1/documents/upload-file",
    { method: "POST", body: form },
    env,
  );

  expect(response.status).toBe(200);
  expect(storedText).toEqual(["café, €100"]);
});
