// Exercises cloud files behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, mock, test } from "bun:test";
import { CloudFilesService, kindFromMime } from "./cloud-files";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

function makeRepository() {
  const create = mock(async (data: Record<string, unknown>) => ({
    ...data,
    created_at: new Date("2026-07-03T00:00:00Z"),
    updated_at: new Date("2026-07-03T00:00:00Z"),
    deleted_at: null,
  }));
  const softDeleteByOrgAndId = mock(async () => ({
    id: "file-1",
    organization_id: ORG,
    storage_key: "cloud-files/key.png",
    source: "upload",
    size_bytes: 5n,
  }));
  const activeStorageKeyReferences = mock(async () => 0);
  return {
    create,
    findActiveByOrgAndId: mock(),
    listByOrganization: mock(),
    softDeleteByOrgAndId,
    activeStorageKeyReferences,
  };
}

function makeQuota() {
  return {
    tryReserveBytes: mock(async () => 5n),
    releaseBytes: mock(async () => undefined),
  };
}

function makeEnv() {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    BLOB: {
      put: mock(
        async (
          key: string,
          body: Uint8Array,
          options?: { httpMetadata?: { contentType?: string } },
        ) => {
          objects.set(key, { body, contentType: options?.httpMetadata?.contentType });
        },
      ),
      delete: mock(async (key: string) => {
        objects.delete(key);
      }),
      get: mock(async () => null),
    },
    R2_PUBLIC_HOST: "blob.test",
    objects,
  };
}

describe("CloudFilesService", () => {
  test("uploads bytes to R2 and records org-scoped metadata", async () => {
    const repository = makeRepository();
    const quota = makeQuota();
    const env = makeEnv();
    const service = new CloudFilesService(repository as never, quota);

    const file = new File(["hello"], "hello.png", { type: "image/png" });
    const result = await service.upload(env as never, {
      organizationId: ORG,
      userId: USER,
      file,
      metadata: { folder: "campaigns" },
    });

    expect(env.BLOB.put).toHaveBeenCalledTimes(1);
    expect(quota.tryReserveBytes).toHaveBeenCalledWith(ORG, 5n);
    expect(quota.releaseBytes).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledTimes(1);
    const createArg = repository.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createArg.organization_id).toBe(ORG);
    expect(createArg.user_id).toBe(USER);
    expect(createArg.filename).toBe("hello.png");
    expect(createArg.mime_type).toBe("image/png");
    expect(createArg.kind).toBe("image");
    expect(createArg.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(String(createArg.storage_url)).toStartWith("https://blob.test/cloud-files/");
    expect(result.metadata).toEqual({ folder: "campaigns" });
  });

  test("removes uploaded bytes if metadata creation fails", async () => {
    const repository = makeRepository();
    repository.create.mockRejectedValueOnce(new Error("insert failed"));
    const quota = makeQuota();
    const env = makeEnv();
    const service = new CloudFilesService(repository as never, quota);

    const file = new File(["hello"], "hello.png", { type: "image/png" });
    await expect(
      service.upload(env as never, {
        organizationId: ORG,
        userId: USER,
        file,
      }),
    ).rejects.toThrow("insert failed");

    const putKey = env.BLOB.put.mock.calls[0]?.[0];
    expect(putKey).toBeTruthy();
    expect(env.BLOB.delete).toHaveBeenCalledWith(putKey);
    expect(quota.releaseBytes).toHaveBeenCalledWith(ORG, 5n);
    expect(env.objects.size).toBe(0);
  });

  test("rejects uploads when org storage quota cannot reserve bytes", async () => {
    const repository = makeRepository();
    const quota = makeQuota();
    quota.tryReserveBytes.mockResolvedValueOnce(null);
    const env = makeEnv();
    const service = new CloudFilesService(repository as never, quota);

    const file = new File(["hello"], "hello.png", { type: "image/png" });
    await expect(
      service.upload(env as never, {
        organizationId: ORG,
        userId: USER,
        file,
      }),
    ).rejects.toThrow("Storage quota exceeded for this organization");

    expect(quota.tryReserveBytes).toHaveBeenCalledWith(ORG, 5n);
    expect(env.BLOB.put).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(quota.releaseBytes).not.toHaveBeenCalled();
  });

  test("soft delete removes the object after the last active reference", async () => {
    const repository = makeRepository();
    const quota = makeQuota();
    const env = makeEnv();
    const service = new CloudFilesService(repository as never, quota);

    const result = await service.delete(env as never, ORG, "file-1");

    expect(result?.id).toBe("file-1");
    expect(repository.softDeleteByOrgAndId).toHaveBeenCalledWith(ORG, "file-1");
    expect(repository.activeStorageKeyReferences).toHaveBeenCalledWith(ORG, "cloud-files/key.png");
    expect(env.BLOB.delete).toHaveBeenCalledWith("cloud-files/key.png");
    expect(quota.releaseBytes).toHaveBeenCalledWith(ORG, 5n);
  });

  test("mime kind classifier covers managed media families", () => {
    expect(kindFromMime("image/webp")).toBe("image");
    expect(kindFromMime("video/mp4")).toBe("video");
    expect(kindFromMime("audio/wav")).toBe("audio");
    expect(kindFromMime("application/pdf")).toBe("document");
    expect(kindFromMime("application/octet-stream")).toBe("other");
  });
});
