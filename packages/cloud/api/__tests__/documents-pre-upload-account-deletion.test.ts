/**
 * A file sent to POST /api/v1/documents/pre-upload and never submitted stays
 * in the blob bucket. Account deletion removes an organization's objects by
 * their organization id, so a pending upload must carry it; otherwise the
 * file outlives the account. Real pre-upload route and real account-deletion
 * object-storage step; the bucket is in memory and the caller is mocked.
 */
import { expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-1111111111a7";
const USER = "22222222-2222-4222-8222-2222222222a7";

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
const storedDocuments: string[] = [];
mock.module("../v1/documents/_worker-documents", () => ({
  ...realWorkerDocuments,
  resolveDocumentScope: async () => ({ agentId: USER, roomId: USER }),
  createDocumentRecord: async (
    _user: unknown,
    _scope: unknown,
    file: { filename: string },
  ) => {
    storedDocuments.push(file.filename);
    return { id: file.filename };
  },
}));

const { Hono } = await import("hono");
const { default: preUploadRoute } = await import(
  "../v1/documents/pre-upload/route"
);
const { default: submitRoute } = await import("../v1/documents/submit/route");
const { createAccountDeletionProviderAdapters } = await import(
  "../../shared/src/lib/services/account-deletion-provider-adapters"
);

type Stored = { customMetadata?: Record<string, string> };
function memoryBucket() {
  const objects = new Map<string, Stored>();
  return {
    objects,
    async put(key: string, _value: unknown, options: Stored = {}) {
      objects.set(key, { customMetadata: options.customMetadata });
    },
    async get(key: string) {
      return objects.has(key)
        ? {
            arrayBuffer: async () =>
              new TextEncoder().encode("%PDF-1.7 \u00e2\u00e3").buffer,
          }
        : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return {
        objects: [...objects].map(([key, value]) => ({ key, ...value })),
        truncated: false,
      };
    },
  };
}

test("account deletion removes a pre-uploaded document that was never submitted", async () => {
  const bucket = memoryBucket();
  const app = new Hono().route("/api/v1/documents/pre-upload", preUploadRoute);
  const form = new FormData();
  form.append(
    "files",
    new File(["quarterly numbers"], "notes.txt", { type: "text/plain" }),
  );
  const response = await app.request(
    "/api/v1/documents/pre-upload",
    { method: "POST", body: form },
    { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true", BLOB: bucket },
  );
  expect(response.status).toBe(200);
  expect(bucket.objects.size).toBe(1);

  const adapters = createAccountDeletionProviderAdapters({
    trajectoryStore: {
      reachable: async () => true,
      listOrganizationKeys: async () => [],
      deleteObject: async () => undefined,
    },
  });
  await adapters.primary_object_storage.execute(
    { organizationId: ORG, userId: USER, blob: bucket } as never,
    "account-deletion:test:primary_object_storage",
  );

  expect(bucket.objects.size).toBe(0);
});

test("submit refuses a pending PDF, deletes its pending blob, and reports a missing file as missing", async () => {
  const bucket = memoryBucket();
  const key = `documents-pre-upload/${USER}/report.pdf`;
  await bucket.put(key, "pdf bytes");
  const app = new Hono().route("/api/v1/documents/submit", submitRoute);
  const submit = (blobUrl: string) =>
    app.request(
      "/api/v1/documents/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterId: "character-1",
          files: [
            {
              blobUrl,
              filename: "report.pdf",
              contentType: "application/pdf",
              size: 9,
            },
          ],
        }),
      },
      { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true", BLOB: bucket },
    );

  const refused = (await (
    await submit(`https://blob.example/${key}`)
  ).json()) as { results: Array<{ status: string; error?: string }> };
  expect(refused.results[0]?.status).toBe("error");
  expect(refused.results[0]?.error).toContain("cannot be read as text");
  expect(bucket.objects.has(key)).toBe(false);
  expect(storedDocuments).toEqual([]);

  const missing = (await (
    await submit(`https://blob.example/documents-pre-upload/${USER}/gone.pdf`)
  ).json()) as { results: Array<{ error?: string }> };
  expect(missing.results[0]?.error).toBe("File not found");
});
