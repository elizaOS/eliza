/**
 * Verifies the typed R2 adapter against a real Brighter S3 storage instance.
 * The upstream signing method is spied so the test remains deterministic and
 * network-free while preserving the dependency's concrete interface.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Storage } from "@brighter/storage-adapter-s3";
import { R2StorageAdapter } from "./r2-storage-adapter";

afterEach(() => {
  mock.restore();
});

describe("R2StorageAdapter.presignGet", () => {
  test("delegates the key and TTL to the upstream GET presign operation", async () => {
    const storage = Storage(
      { path: "test-bucket" },
      {
        region: "auto",
        endpoint: "https://example.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        forcePathStyle: true,
      },
    );
    const upstreamPresign = spyOn(storage, "presign").mockResolvedValue(
      "https://r2.example.test/signed-object",
    );
    const adapter = new R2StorageAdapter(storage);

    await expect(adapter.presignGet("org/org-1/voice/message.ogg", 600)).resolves.toBe(
      "https://r2.example.test/signed-object",
    );
    expect(upstreamPresign).toHaveBeenCalledTimes(1);
    expect(upstreamPresign).toHaveBeenCalledWith("org/org-1/voice/message.ogg", { expiresIn: 600 });
  });
});
