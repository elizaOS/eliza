/**
 * Avatar upload quota and multipart-budget contract tests for #20950 / #24066.
 *
 * These tests drive both real Hono route modules and the real
 * `putPublicObject` helper. Only request authentication, rate limiting, the
 * quota repository, and the user-avatar database boundary are replaced with
 * hermetic boundaries. The in-memory BLOB binding therefore proves the route
 * ordering and compensation behavior without reaching live R2 or Postgres.
 * Envelope-budget cases drive a real streaming Request through the same
 * handlers so declared-length, streamed overflow, untrusted content-length,
 * cancellation reporting, and client-abort paths are pinned in the maintained
 * suite rather than PR-only ad hoc evidence.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as loggerActual from "@/lib/utils/logger";
import type { Bindings } from "@/types/cloud-worker-env";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";
const PUBLIC_HOST = "blob.test";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_AVATAR_BYTES + 1024 * 1024;
const VALID_AVATAR_CONTENT = "avatar";
const VALID_AVATAR_BYTES = BigInt(VALID_AVATAR_CONTENT.length);
const SENSITIVE_UUID = "3f10dc7c-9824-4ba6-aa10-c9a63429b055";
const SENSITIVE_URL = `https://private.example.test/avatar/${SENSITIVE_UUID}?token=do-not-log`;
const SENSITIVE_SQL_PARAMS =
  'SQL params: ["tenant-private", "avatar-private", 5242880]';
const operations: string[] = [];

const loggerWarn = mock((..._args: unknown[]): void => undefined);
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    warn: loggerWarn,
    redact: loggerActual.redact,
  },
}));

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORGANIZATION_ID,
  organization: {
    id: ORGANIZATION_ID,
    name: "Quota Test Organization",
    is_active: true,
  },
  is_active: true,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const tryReserveBytes = mock(
  async (_organizationId: string, bytes: bigint): Promise<bigint | null> => {
    operations.push("reserve");
    return bytes;
  },
);
const releaseBytes = mock(
  async (_organizationId: string, _bytes: bigint): Promise<void> => {
    operations.push("release");
  },
);

mock.module("@/db/repositories/org-storage-quota", () => ({
  orgStorageQuotaRepository: { tryReserveBytes, releaseBytes },
}));

const databaseReturning = mock(async (): Promise<Array<{ id: string }>> => {
  operations.push("database");
  return [{ id: USER_ID }];
});
const databaseWhere = mock((_predicate: unknown) => ({
  returning: databaseReturning,
}));
let capturedAvatarUrl: string | undefined;
const databaseSet = mock((values: Record<string, unknown>) => {
  capturedAvatarUrl =
    typeof values.avatar === "string" ? values.avatar : undefined;
  return { where: databaseWhere };
});
const databaseUpdate = mock((_table: unknown) => ({ set: databaseSet }));
const databaseFindFirst = mock(
  async (_query: unknown): Promise<{ avatar: string | null } | null> => {
    operations.push("readback");
    return null;
  },
);

mock.module("@/db/helpers", () => ({
  dbWrite: {
    update: databaseUpdate,
    query: { users: { findFirst: databaseFindFirst } },
  },
}));

const [characterAvatarRoute, userAvatarRoute] = await Promise.all([
  import("../my-agents/characters/avatar/route").then(
    (module) => module.default,
  ),
  import("../v1/user/avatar/route").then((module) => module.default),
]);

type BlobOptions = Parameters<Bindings["BLOB"]["put"]>[2];

interface MemoryBlobOptions {
  putError?: Error;
  commitBeforePutError?: boolean;
  deleteError?: Error;
}

function copyBytes(
  value: string | ArrayBuffer | ArrayBufferView | Blob | null,
): Promise<Uint8Array> | Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value).slice();
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  }
  if (value instanceof Blob) {
    return value.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Uint8Array();
}

function makeMemoryBlob(options: MemoryBlobOptions = {}) {
  const objects = new Map<string, Uint8Array>();
  const put = mock(
    async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | Blob | null,
      _putOptions?: BlobOptions,
    ): Promise<void> => {
      operations.push("put");
      if (!options.putError || options.commitBeforePutError) {
        objects.set(key, await copyBytes(value));
      }
      if (options.putError) throw options.putError;
    },
  );
  const remove = mock(async (key: string): Promise<void> => {
    operations.push("delete");
    if (options.deleteError) throw options.deleteError;
    objects.delete(key);
  });
  const binding = {
    get: async (key: string) => {
      const value = objects.get(key);
      if (!value) return null;
      return {
        text: async () => new TextDecoder().decode(value),
        arrayBuffer: async () => value.slice().buffer,
      };
    },
    put,
    delete: remove,
  } satisfies Bindings["BLOB"];

  return { binding, objects, put, remove };
}

function makeEnv(blob: Bindings["BLOB"]): Bindings {
  return {
    DATABASE_URL: "postgresql://test.invalid/avatar-quota",
    BLOB: blob,
    R2_PUBLIC_HOST: PUBLIC_HOST,
  };
}

function avatarFile(
  content: BlobPart = VALID_AVATAR_CONTENT,
  type = "image/png",
  name = "avatar.png",
): File {
  return new File([content], name, { type });
}

function uploadAvatar(
  route: typeof characterAvatarRoute,
  file: File,
  blob: Bindings["BLOB"],
): Response | Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  return route.request(
    "/",
    {
      method: "POST",
      body: form,
    },
    makeEnv(blob),
  );
}

async function uploadAvatarWithHeaders(
  route: typeof characterAvatarRoute,
  file: File,
  blob: Bindings["BLOB"],
  extraHeaders: HeadersInit,
): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  const base = new Request("http://localhost/", {
    body: form,
    method: "POST",
  });
  const headers = new Headers(base.headers);
  for (const [key, value] of new Headers(extraHeaders)) {
    headers.set(key, value);
  }
  const request = new Request(base.url, {
    body: await base.arrayBuffer(),
    headers,
    method: base.method,
  });
  return route.request(request, undefined, makeEnv(blob));
}

function streamAvatarRequest(
  chunks: readonly Uint8Array[],
  headers: HeadersInit,
  options: {
    onCancel?: () => void | Promise<void>;
    signal?: AbortSignal;
    leaveOpen?: boolean;
  } = {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      return options.onCancel?.();
    },
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      if (!options.leaveOpen) {
        controller.close();
      }
    },
  });
  const nextHeaders = new Headers({
    "content-type": "multipart/form-data; boundary=budget",
  });
  for (const [key, value] of new Headers(headers)) {
    nextHeaders.set(key, value);
  }
  return new Request("http://localhost/", {
    body,
    headers: nextHeaders,
    method: "POST",
    signal: options.signal,
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sensitiveErrorMessage(label: string): string {
  return `${label}; tenant=${SENSITIVE_UUID}; url=${SENSITIVE_URL}; ${SENSITIVE_SQL_PARAMS}`;
}

async function expectPrivateInternalError(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(body).toBe(
    JSON.stringify({
      success: false,
      error: "An unexpected error occurred",
      code: "internal_error",
    }),
  );
  expect(body).not.toContain(SENSITIVE_UUID);
  expect(body).not.toContain(SENSITIVE_URL);
  expect(body).not.toContain(SENSITIVE_SQL_PARAMS);
}

function expectSafeAvatarWarning(
  stage:
    | "r2_put_compensation"
    | "avatar_persistence_compensation"
    | "avatar_persistence_ack_readback",
  reason:
    | "object_delete_failed"
    | "quota_release_failed"
    | "readback_failed"
    | "avatar_not_confirmed",
  rawMessages: readonly string[],
): void {
  expect(loggerWarn).toHaveBeenCalledTimes(1);
  const warning = loggerWarn.mock.calls.at(-1);
  if (!warning) throw new Error("Expected a captured avatar warning");
  const serialized = JSON.stringify(warning);
  if (typeof serialized !== "string") {
    throw new Error("Expected avatar warning arguments to serialize");
  }

  expect(serialized).not.toContain(SENSITIVE_UUID);
  expect(serialized).not.toContain(SENSITIVE_URL);
  expect(serialized).not.toContain(SENSITIVE_SQL_PARAMS);
  for (const rawMessage of rawMessages) {
    expect(serialized).not.toContain(rawMessage);
  }
  expect(serialized).not.toContain(ORGANIZATION_ID);
  expect(serialized).not.toContain(USER_ID);
  expect(serialized).toContain(loggerActual.redact.orgId(ORGANIZATION_ID));
  expect(serialized).toContain(loggerActual.redact.userId(USER_ID));
  expect(serialized).toContain(`"reservedBytes":"${VALID_AVATAR_BYTES}"`);
  expect(serialized).toContain(`"stage":"${stage}"`);
  expect(serialized).toContain(`"reason":"${reason}"`);
}

beforeEach(() => {
  operations.length = 0;
  capturedAvatarUrl = undefined;
  loggerWarn.mockClear();
  requireUserOrApiKeyWithOrg.mockClear();
  tryReserveBytes.mockReset();
  tryReserveBytes.mockImplementation(async (_organizationId, bytes) => {
    operations.push("reserve");
    return bytes;
  });
  releaseBytes.mockReset();
  releaseBytes.mockImplementation(async () => {
    operations.push("release");
  });
  databaseReturning.mockReset();
  databaseReturning.mockImplementation(async () => {
    operations.push("database");
    return [{ id: USER_ID }];
  });
  databaseFindFirst.mockReset();
  databaseFindFirst.mockImplementation(async () => {
    operations.push("readback");
    return null;
  });
  databaseWhere.mockClear();
  databaseSet.mockClear();
  databaseUpdate.mockClear();
});

const routeCases = [
  {
    name: "character avatar",
    route: characterAvatarRoute,
    persistsUser: false,
  },
  { name: "user avatar", route: userAvatarRoute, persistsUser: true },
] as const;

for (const routeCase of routeCases) {
  describe(routeCase.name, () => {
    test("rejects an unsupported MIME type before reserving quota", async () => {
      const blob = makeMemoryBlob();

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile("plain text", "text/plain", "avatar.txt"),
        blob.binding,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        JSON.stringify({
          success: false,
          error: "Unsupported image type",
        }),
      );
      expect(tryReserveBytes).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(databaseUpdate).not.toHaveBeenCalled();
    });

    test("rejects an oversized image before reserving quota", async () => {
      const blob = makeMemoryBlob();

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile(new ArrayBuffer(MAX_AVATAR_BYTES + 1)),
        blob.binding,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        JSON.stringify({
          success: false,
          error: "File too large (max 5MB)",
        }),
      );
      expect(tryReserveBytes).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(databaseUpdate).not.toHaveBeenCalled();
    });

    test("returns the exact 413 contract without R2 or DB work when quota is full", async () => {
      const blob = makeMemoryBlob();
      tryReserveBytes.mockImplementationOnce(async () => {
        operations.push("reserve");
        return null;
      });

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile(),
        blob.binding,
      );

      expect(response.status).toBe(413);
      expect(await response.text()).toBe(
        JSON.stringify({
          success: false,
          error: "Storage quota exceeded for this organization",
        }),
      );
      expect(tryReserveBytes).toHaveBeenCalledTimes(1);
      expect(tryReserveBytes).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        VALID_AVATAR_BYTES,
      );
      expect(blob.put).not.toHaveBeenCalled();
      expect(blob.remove).not.toHaveBeenCalled();
      expect(databaseUpdate).not.toHaveBeenCalled();
      expect(releaseBytes).not.toHaveBeenCalled();
    });

    test("releases the exact reservation once when the R2 put rejects", async () => {
      const blob = makeMemoryBlob({
        putError: new Error("R2 put failed"),
        commitBeforePutError: true,
      });

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile(),
        blob.binding,
      );

      expect(response.status).toBe(500);
      expect(tryReserveBytes).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        VALID_AVATAR_BYTES,
      );
      expect(blob.put).toHaveBeenCalledTimes(1);
      expect(blob.remove).toHaveBeenCalledTimes(1);
      expect(releaseBytes).toHaveBeenCalledTimes(1);
      expect(releaseBytes).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        VALID_AVATAR_BYTES,
      );
      expect(databaseUpdate).not.toHaveBeenCalled();
      expect(operations).toEqual(["reserve", "put", "delete", "release"]);
      expect(blob.objects.size).toBe(0);
    });

    test("preserves the R2 put error when compensating quota release rejects", async () => {
      const putErrorMessage = sensitiveErrorMessage("original R2 put failure");
      const releaseErrorMessage = sensitiveErrorMessage(
        "quota release failure",
      );
      const originalError = new Error(putErrorMessage);
      const blob = makeMemoryBlob({
        putError: originalError,
        commitBeforePutError: true,
      });
      releaseBytes.mockImplementationOnce(async () => {
        operations.push("release");
        throw new Error(releaseErrorMessage);
      });

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile(),
        blob.binding,
      );

      await expectPrivateInternalError(response);
      expect(blob.put).toHaveBeenCalledTimes(1);
      expect(blob.remove).toHaveBeenCalledTimes(1);
      expect(releaseBytes).toHaveBeenCalledTimes(1);
      expect(releaseBytes).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        VALID_AVATAR_BYTES,
      );
      expect(databaseUpdate).not.toHaveBeenCalled();
      expect(operations).toEqual(["reserve", "put", "delete", "release"]);
      expect(blob.objects.size).toBe(0);
      expectSafeAvatarWarning("r2_put_compensation", "quota_release_failed", [
        putErrorMessage,
        releaseErrorMessage,
      ]);
    });

    test("retains the reservation when cleanup after an R2 put error cannot delete", async () => {
      const putErrorMessage = sensitiveErrorMessage("original R2 put failure");
      const deleteErrorMessage = sensitiveErrorMessage("R2 delete failure");
      const originalError = new Error(putErrorMessage);
      const blob = makeMemoryBlob({
        putError: originalError,
        commitBeforePutError: true,
        deleteError: new Error(deleteErrorMessage),
      });

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile(),
        blob.binding,
      );

      await expectPrivateInternalError(response);
      expect(blob.put).toHaveBeenCalledTimes(1);
      expect(blob.remove).toHaveBeenCalledTimes(1);
      expect(releaseBytes).not.toHaveBeenCalled();
      expect(databaseUpdate).not.toHaveBeenCalled();
      expect(operations).toEqual(["reserve", "put", "delete"]);
      expect(blob.objects.size).toBe(1);
      expectSafeAvatarWarning("r2_put_compensation", "object_delete_failed", [
        putErrorMessage,
        deleteErrorMessage,
      ]);
    });

    test("reserves the exact bytes and keeps the reservation after a successful upload", async () => {
      const blob = makeMemoryBlob();

      const response = await uploadAvatar(
        routeCase.route,
        avatarFile(),
        blob.binding,
      );

      expect(response.status).toBe(200);
      expect(tryReserveBytes).toHaveBeenCalledTimes(1);
      expect(tryReserveBytes).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        VALID_AVATAR_BYTES,
      );
      expect(blob.put).toHaveBeenCalledTimes(1);
      expect(blob.objects.size).toBe(1);
      expect([...blob.objects.values()][0]).toEqual(
        new TextEncoder().encode(VALID_AVATAR_CONTENT),
      );
      expect(releaseBytes).not.toHaveBeenCalled();

      if (routeCase.persistsUser) {
        expect(databaseUpdate).toHaveBeenCalledTimes(1);
        expect(operations).toEqual(["reserve", "put", "database"]);
      } else {
        expect(databaseUpdate).not.toHaveBeenCalled();
        expect(operations).toEqual(["reserve", "put"]);
      }
    });

    test("rejects a declared oversize envelope before parsing or reserving quota", async () => {
      const blob = makeMemoryBlob();
      const onCancel = mock(() => undefined);

      const response = await routeCase.route.request(
        streamAvatarRequest(
          [new Uint8Array(8)],
          { "content-length": String(MAX_MULTIPART_BODY_BYTES + 1) },
          { onCancel },
        ),
        undefined,
        makeEnv(blob.binding),
      );

      expect(response.status).toBe(413);
      expect(await response.text()).toBe(
        JSON.stringify({
          success: false,
          error: `Upload exceeds the ${MAX_MULTIPART_BODY_BYTES} byte request limit (${MAX_MULTIPART_BODY_BYTES + 1})`,
        }),
      );
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(tryReserveBytes).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(databaseUpdate).not.toHaveBeenCalled();
    });

    test("cancels a streamed oversize envelope before reserving quota", async () => {
      const blob = makeMemoryBlob();
      const onCancel = mock(() => undefined);

      const response = await routeCase.route.request(
        streamAvatarRequest(
          [new Uint8Array(MAX_MULTIPART_BODY_BYTES + 1)],
          {},
          { leaveOpen: true, onCancel },
        ),
        undefined,
        makeEnv(blob.binding),
      );

      expect(response.status).toBe(413);
      expect(await response.text()).toBe(
        JSON.stringify({
          success: false,
          error: `Upload exceeds the ${MAX_MULTIPART_BODY_BYTES} byte request limit (${MAX_MULTIPART_BODY_BYTES + 1})`,
        }),
      );
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(tryReserveBytes).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(databaseUpdate).not.toHaveBeenCalled();
    });

    test("does not treat malformed content-length as a budget grant", async () => {
      const blob = makeMemoryBlob();

      for (const header of ["abc", "0x400", "-1", "99999999999999999999", ""]) {
        tryReserveBytes.mockClear();
        blob.put.mockClear();
        const response = await uploadAvatarWithHeaders(
          routeCase.route,
          avatarFile(),
          blob.binding,
          { "content-length": header },
        );

        expect(response.status).toBe(200);
        expect(tryReserveBytes).toHaveBeenCalledTimes(1);
        expect(blob.put).toHaveBeenCalledTimes(1);
      }
    });

    test("returns 408 when the client aborts before the body is read", async () => {
      const blob = makeMemoryBlob();
      const controller = new AbortController();
      const request = streamAvatarRequest(
        [new Uint8Array(8)],
        {},
        { leaveOpen: true, signal: controller.signal },
      );
      controller.abort();

      const response = await routeCase.route.request(
        request,
        undefined,
        makeEnv(blob.binding),
      );

      expect(response.status).toBe(408);
      expect(await response.text()).toBe(
        JSON.stringify({
          success: false,
          error: "Upload body could not be read",
        }),
      );
      expect(tryReserveBytes).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalled();
    });

    test("reports a rejecting body cancel without reserving quota", async () => {
      const blob = makeMemoryBlob();
      const onCancel = mock(async () => {
        throw new Error("cancel exploded");
      });

      const response = await routeCase.route.request(
        streamAvatarRequest(
          [new Uint8Array(MAX_MULTIPART_BODY_BYTES + 1)],
          {},
          { leaveOpen: true, onCancel },
        ),
        undefined,
        makeEnv(blob.binding),
      );

      expect(response.status).toBe(413);
      expect(tryReserveBytes).not.toHaveBeenCalled();
      await waitUntil(() => loggerWarn.mock.calls.length >= 1);
      const serialized = JSON.stringify(loggerWarn.mock.calls);
      expect(serialized).toContain("Failed to cancel upload body");
      expect(serialized).toContain("streamed-budget");
    });
  });
}

describe("user avatar database compensation", () => {
  test("accepts an ambiguous update as committed when readback matches the new avatar", async () => {
    const originalError = new Error("ambiguous avatar database failure");
    databaseReturning.mockImplementationOnce(async () => {
      operations.push("database");
      throw originalError;
    });
    databaseFindFirst.mockImplementationOnce(async () => {
      operations.push("readback");
      return capturedAvatarUrl === undefined
        ? null
        : { avatar: capturedAvatarUrl };
    });
    const blob = makeMemoryBlob();

    const response = await uploadAvatar(
      userAvatarRoute,
      avatarFile(),
      blob.binding,
    );

    const avatarUrl = capturedAvatarUrl;
    if (avatarUrl === undefined) {
      throw new Error("Expected the avatar update mock to capture its URL");
    }

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      JSON.stringify({
        success: true,
        avatarUrl,
        message: "Avatar uploaded successfully",
      }),
    );
    expect(databaseSet).toHaveBeenCalledWith({ avatar: avatarUrl });
    expect(databaseFindFirst).toHaveBeenCalledTimes(1);
    expect(blob.remove).not.toHaveBeenCalled();
    expect(releaseBytes).not.toHaveBeenCalled();
    expect(operations).toEqual(["reserve", "put", "database", "readback"]);
    expect(blob.objects.size).toBe(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  const inconclusiveReadbacks = [
    {
      name: "a different avatar",
      value: { avatar: "https://blob.test/avatars/users/existing.png" },
    },
    { name: "no user", value: null },
  ] as const;

  for (const readback of inconclusiveReadbacks) {
    test(`preserves an ambiguous update error and uploaded object when readback finds ${readback.name}`, async () => {
      const updateErrorMessage = sensitiveErrorMessage(
        "original ambiguous avatar database failure",
      );
      const originalError = new Error(updateErrorMessage);
      databaseReturning.mockImplementationOnce(async () => {
        operations.push("database");
        throw originalError;
      });
      databaseFindFirst.mockImplementationOnce(async () => {
        operations.push("readback");
        return readback.value;
      });
      const blob = makeMemoryBlob();

      const response = await uploadAvatar(
        userAvatarRoute,
        avatarFile(),
        blob.binding,
      );

      await expectPrivateInternalError(response);
      expect(databaseFindFirst).toHaveBeenCalledTimes(1);
      expect(blob.remove).not.toHaveBeenCalled();
      expect(releaseBytes).not.toHaveBeenCalled();
      expect(operations).toEqual(["reserve", "put", "database", "readback"]);
      expect(blob.objects.size).toBe(1);
      expectSafeAvatarWarning(
        "avatar_persistence_ack_readback",
        "avatar_not_confirmed",
        [updateErrorMessage],
      );
    });
  }

  test("preserves the update error and uploaded object when readback also fails", async () => {
    const updateErrorMessage = sensitiveErrorMessage(
      "original ambiguous avatar database failure",
    );
    const readbackErrorMessage = sensitiveErrorMessage(
      "avatar database readback failure",
    );
    const originalError = new Error(updateErrorMessage);
    databaseReturning.mockImplementationOnce(async () => {
      operations.push("database");
      throw originalError;
    });
    databaseFindFirst.mockImplementationOnce(async () => {
      operations.push("readback");
      throw new Error(readbackErrorMessage);
    });
    const blob = makeMemoryBlob();

    const response = await uploadAvatar(
      userAvatarRoute,
      avatarFile(),
      blob.binding,
    );

    await expectPrivateInternalError(response);
    expect(databaseFindFirst).toHaveBeenCalledTimes(1);
    expect(blob.remove).not.toHaveBeenCalled();
    expect(releaseBytes).not.toHaveBeenCalled();
    expect(operations).toEqual(["reserve", "put", "database", "readback"]);
    expect(blob.objects.size).toBe(1);
    expectSafeAvatarWarning(
      "avatar_persistence_ack_readback",
      "readback_failed",
      [updateErrorMessage, readbackErrorMessage],
    );
  });

  test("does not release quota when compensating R2 deletion fails", async () => {
    const deleteErrorMessage = sensitiveErrorMessage("R2 delete failure");
    databaseReturning.mockImplementationOnce(async () => {
      operations.push("database");
      return [];
    });
    const blob = makeMemoryBlob({
      deleteError: new Error(deleteErrorMessage),
    });

    const response = await uploadAvatar(
      userAvatarRoute,
      avatarFile(),
      blob.binding,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      JSON.stringify({
        success: false,
        error: "User not found",
        code: "resource_not_found",
      }),
    );
    expect(databaseFindFirst).not.toHaveBeenCalled();
    expect(blob.remove).toHaveBeenCalledTimes(1);
    expect(releaseBytes).not.toHaveBeenCalled();
    expect(operations).toEqual(["reserve", "put", "database", "delete"]);
    expect(blob.objects.size).toBe(1);
    expectSafeAvatarWarning(
      "avatar_persistence_compensation",
      "object_delete_failed",
      [deleteErrorMessage],
    );
  });

  test("keeps the object deleted while preserving the not-found error when quota release fails", async () => {
    const releaseErrorMessage = sensitiveErrorMessage("quota release failure");
    databaseReturning.mockImplementationOnce(async () => {
      operations.push("database");
      return [];
    });
    releaseBytes.mockImplementationOnce(async () => {
      operations.push("release");
      throw new Error(releaseErrorMessage);
    });
    const blob = makeMemoryBlob();

    const response = await uploadAvatar(
      userAvatarRoute,
      avatarFile(),
      blob.binding,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      JSON.stringify({
        success: false,
        error: "User not found",
        code: "resource_not_found",
      }),
    );
    expect(databaseFindFirst).not.toHaveBeenCalled();
    expect(blob.remove).toHaveBeenCalledTimes(1);
    expect(releaseBytes).toHaveBeenCalledTimes(1);
    expect(releaseBytes).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      VALID_AVATAR_BYTES,
    );
    expect(operations).toEqual([
      "reserve",
      "put",
      "database",
      "delete",
      "release",
    ]);
    expect(blob.objects.size).toBe(0);
    expectSafeAvatarWarning(
      "avatar_persistence_compensation",
      "quota_release_failed",
      [releaseErrorMessage],
    );
  });

  test("compensates a tenant-scoped avatar update that returns no user", async () => {
    databaseReturning.mockImplementationOnce(async () => {
      operations.push("database");
      return [];
    });
    const blob = makeMemoryBlob();

    const response = await uploadAvatar(
      userAvatarRoute,
      avatarFile(),
      blob.binding,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      JSON.stringify({
        success: false,
        error: "User not found",
        code: "resource_not_found",
      }),
    );
    expect(databaseReturning).toHaveBeenCalledTimes(1);
    expect(databaseFindFirst).not.toHaveBeenCalled();
    expect(blob.remove).toHaveBeenCalledTimes(1);
    expect(releaseBytes).toHaveBeenCalledTimes(1);
    expect(releaseBytes).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      VALID_AVATAR_BYTES,
    );
    expect(operations).toEqual([
      "reserve",
      "put",
      "database",
      "delete",
      "release",
    ]);
    expect(blob.objects.size).toBe(0);
  });
});
