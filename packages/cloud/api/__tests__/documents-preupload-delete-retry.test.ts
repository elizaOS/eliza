// Exercises cloud API tests documents preupload delete retry.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as loggerActual from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const requireUserOrApiKeyWithOrg =
  mock<() => Promise<{ id: string; organization_id: string }>>();
const loggerWarn = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    warn: loggerWarn,
  },
}));

mock.module("../v1/documents/_worker-documents", () => ({
  publicBlobUrl: (_c: unknown, key: string) =>
    `https://blob.elizacloud.ai/${key}`,
  r2KeyFromBlobUrl: (blobUrl: string) => {
    try {
      const key = new URL(blobUrl).pathname.replace(/^\/+/, "");
      return key.startsWith("documents-pre-upload/") ? key : null;
    } catch {
      return null;
    }
  },
  sanitizeFilename: (filename: string) => filename,
  validateDocumentFiles: () => null,
}));

const [{ default: preUploadRoute }, { deletePendingDocumentBlob }] =
  await Promise.all([
    import("../v1/documents/pre-upload/route"),
    import("../v1/documents/_pending-blob-cleanup"),
  ]);

const app = new Hono<AppEnv>().route(
  "/api/v1/documents/pre-upload",
  preUploadRoute,
);

function deleteRequest(blobUrl: string): Request {
  return new Request("https://api.example.test/api/v1/documents/pre-upload", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer eliza_test",
    },
    body: JSON.stringify({ blobUrl }),
  });
}

describe("DELETE /api/v1/documents/pre-upload cleanup", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    loggerWarn.mockReset();
  });

  test("retries a transient R2 delete failure after URL ownership is validated", async () => {
    const deleteBlob = mock()
      .mockRejectedValueOnce(new Error("r2 transient 503"))
      .mockResolvedValueOnce(undefined);
    const env = {
      BLOB: {
        get: mock(),
        put: mock(),
        delete: deleteBlob,
      },
      CACHE_ENABLED: "false",
      NODE_ENV: "test",
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(
      deleteRequest(
        "https://blob.elizacloud.ai/documents-pre-upload/user-1/pending.txt",
      ),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ success: true });
    expect(deleteBlob).toHaveBeenCalledTimes(2);
    expect(deleteBlob).toHaveBeenCalledWith(
      "documents-pre-upload/user-1/pending.txt",
    );
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  test("keeps missing object storage as a loud deployment 503", async () => {
    const res = await app.fetch(
      deleteRequest(
        "https://blob.elizacloud.ai/documents-pre-upload/user-1/pending.txt",
      ),
      {
        CACHE_ENABLED: "false",
        NODE_ENV: "test",
      } as unknown as AppEnv["Bindings"],
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      error: "Object storage is not configured",
    });
  });
});

describe("deletePendingDocumentBlob", () => {
  beforeEach(() => {
    loggerWarn.mockReset();
  });

  test("throws after exhausting the retry budget", async () => {
    const deleteBlob = mock(() => Promise.reject(new Error("r2 unavailable")));

    await expect(
      deletePendingDocumentBlob(
        {
          get: mock(),
          put: mock(),
          delete: deleteBlob,
        } as unknown as AppEnv["Bindings"]["BLOB"],
        "documents-pre-upload/user-1/pending.txt",
      ),
    ).rejects.toThrow("r2 unavailable");

    expect(deleteBlob).toHaveBeenCalledTimes(3);
    expect(loggerWarn).toHaveBeenCalledTimes(2);
  });
});
