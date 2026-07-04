// Exercises cloud API tests cloud files route.test behavior with deterministic Worker route fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as cloudFilesActual from "@/lib/services/cloud-files";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000bb";
const FILE_ID = "00000000-0000-4000-8000-0000000000dd";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STANDARD: { limit: 1, windowSeconds: 1 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const list = mock();
const get = mock();
const upload = mock();
const deleteFile = mock();
mock.module("@/lib/services/cloud-files", () => ({
  ...cloudFilesActual,
  cloudFilesService: {
    ...cloudFilesActual.cloudFilesService,
    list,
    get,
    upload,
    delete: deleteFile,
  },
}));

const filesRoute = (await import("../v1/files/route")).default;
const fileRoute = (await import("../v1/files/[id]/route")).default;
const fileRouteWithParam = new Hono().route("/:id", fileRoute);

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/services/cloud-files", () => cloudFilesActual);
});

function fileRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    organization_id: ORG,
    user_id: USER,
    api_key_id: null,
    generation_id: null,
    source: "upload",
    kind: "image",
    filename: "hero.png",
    mime_type: "image/png",
    size_bytes: BigInt(5),
    sha256: "abc123",
    storage_key: "cloud-files/key.png",
    storage_url: "https://blob.test/cloud-files/key.png",
    status: "active",
    metadata: { folder: "campaigns" },
    created_at: new Date("2026-07-03T00:00:00Z"),
    updated_at: new Date("2026-07-03T00:00:00Z"),
    deleted_at: null,
    ...overrides,
  };
}

function env() {
  return {
    BLOB: {
      put: mock(async () => undefined),
      delete: mock(async () => undefined),
      get: mock(async () => null),
    },
  };
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  list.mockReset();
  get.mockReset();
  upload.mockReset();
  deleteFile.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(
    async (c: { set: (key: string, value: unknown) => void }) => {
      c.set("apiKeyId", "key-1");
      return {
        id: USER,
        organization_id: ORG,
        organization: { id: ORG, name: "Org", is_active: true },
        is_active: true,
      };
    },
  );
});

describe("/api/v1/files", () => {
  test("lists active files scoped to the authenticated organization with filters and pagination", async () => {
    list.mockResolvedValue({
      items: [fileRecord()],
      limit: 2,
      offset: 4,
      hasMore: true,
    });

    const res = await filesRoute.request(
      "/?limit=2&offset=4&kind=image&source=upload&mimeType=image/png&q=hero",
      { headers: { Authorization: "Bearer test" } },
      env() as never,
    );

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      organizationId: ORG,
      limit: 2,
      offset: 4,
      kind: "image",
      source: "upload",
      mimeType: "image/png",
      search: "hero",
    });
    const body = (await res.json()) as {
      pagination: unknown;
      files: Array<Record<string, unknown>>;
    };
    expect(body.pagination).toEqual({
      limit: 2,
      offset: 4,
      hasMore: true,
      nextOffset: 6,
    });
    expect(body.files[0]).toMatchObject({
      id: FILE_ID,
      filename: "hero.png",
      sizeBytes: 5,
      metadata: { folder: "campaigns" },
    });
  });

  test("uploads multipart files with metadata", async () => {
    upload.mockResolvedValue(fileRecord());
    const form = new FormData();
    form.append(
      "files",
      new File(["hello"], "hero.png", { type: "image/png" }),
    );
    form.append("metadata", JSON.stringify({ folder: "campaigns" }));

    const res = await filesRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );

    expect(res.status).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
    const uploadArg = upload.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(uploadArg.organizationId).toBe(ORG);
    expect(uploadArg.userId).toBe(USER);
    expect(uploadArg.apiKeyId).toBe("key-1");
    expect(uploadArg.metadata).toEqual({ folder: "campaigns" });
    const body = (await res.json()) as {
      files: Array<Record<string, unknown>>;
    };
    expect(body.files[0].url).toBe("https://blob.test/cloud-files/key.png");
  });

  test("rejects upload requests with too many files before storage writes", async () => {
    const form = new FormData();
    for (let index = 0; index < 11; index += 1) {
      form.append(
        "files",
        new File(["hello"], `hero-${index}.png`, { type: "image/png" }),
      );
    }

    const res = await filesRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );

    expect(res.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Too many files");
  });

  test("returns 413 when org storage quota cannot reserve upload bytes", async () => {
    upload.mockRejectedValueOnce(
      new cloudFilesActual.CloudFileQuotaExceededError(),
    );
    const form = new FormData();
    form.append("file", new File(["hello"], "hero.png", { type: "image/png" }));

    const res = await filesRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Storage quota exceeded for this organization");
  });

  test("rolls back earlier multipart uploads when a later file exceeds quota", async () => {
    upload
      .mockResolvedValueOnce(fileRecord({ id: FILE_ID }))
      .mockRejectedValueOnce(
        new cloudFilesActual.CloudFileQuotaExceededError(),
      );
    deleteFile.mockResolvedValueOnce(fileRecord({ id: FILE_ID }));
    const form = new FormData();
    form.append(
      "files",
      new File(["first"], "first.png", { type: "image/png" }),
    );
    form.append(
      "files",
      new File(["second"], "second.png", { type: "image/png" }),
    );

    const routeEnv = env();
    const res = await filesRoute.request(
      "/",
      { method: "POST", body: form },
      routeEnv as never,
    );

    expect(res.status).toBe(413);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith(routeEnv, ORG, FILE_ID);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Storage quota exceeded for this organization");
  });

  test("rejects oversized multipart requests before any storage writes", async () => {
    const form = new FormData();
    form.append(
      "files",
      new File(["first"], "first.png", { type: "image/png" }),
    );
    form.append(
      "files",
      new File(["x".repeat(50 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      }),
    );

    const res = await filesRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );

    expect(res.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
  });

  test("rejects malformed upload metadata as validation error", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "hero.png", { type: "image/png" }));
    form.append("metadata", "{bad json");

    const res = await filesRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );

    expect(res.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("/api/v1/files/:id", () => {
  test("gets a file only through the caller organization scope", async () => {
    get.mockImplementation(async (organizationId: string, id: string) => {
      if (organizationId !== ORG || id !== FILE_ID) return undefined;
      return fileRecord();
    });

    const res = await fileRouteWithParam.request(
      `/${FILE_ID}`,
      {},
      env() as never,
    );

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith(ORG, FILE_ID);
    const body = (await res.json()) as { file: { id: string } };
    expect(body.file.id).toBe(FILE_ID);
  });

  test("returns 404 when a file belongs to another organization", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValueOnce({
      id: USER,
      organization_id: OTHER_ORG,
      is_active: true,
    });
    get.mockResolvedValue(undefined);

    const res = await fileRouteWithParam.request(
      `/${FILE_ID}`,
      {},
      env() as never,
    );

    expect(res.status).toBe(404);
    expect(get).toHaveBeenCalledWith(OTHER_ORG, FILE_ID);
  });

  test("deletes through organization scope", async () => {
    deleteFile.mockResolvedValue(fileRecord());

    const res = await fileRouteWithParam.request(
      `/${FILE_ID}`,
      { method: "DELETE" },
      env() as never,
    );

    expect(res.status).toBe(200);
    expect(deleteFile).toHaveBeenCalledWith(expect.any(Object), ORG, FILE_ID);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: true,
      deleted: true,
      id: FILE_ID,
    });
  });

  test("rejects malformed file ids before service access", async () => {
    const res = await fileRouteWithParam.request(
      "/not-a-uuid",
      {},
      env() as never,
    );

    expect(res.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
