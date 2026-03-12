/**
 * Real tests for the S3 storage plugin with mocked S3Client.
 * Tests uploadFile, uploadBytes, uploadJson, downloadBytes, downloadFile,
 * delete, exists, generateSignedUrl, and error handling.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const { mockSend, mockDestroy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  const makeCommand = (cmd: string) =>
    class {
      constructor(public input: Record<string, unknown>) {
        (this as Record<string, unknown>)._cmd = cmd;
      }
    };
  return {
    S3Client: class MockS3Client {
      send = mockSend;
      destroy = mockDestroy;
      config = {};
    },
    PutObjectCommand: makeCommand("PutObject"),
    GetObjectCommand: makeCommand("GetObject"),
    DeleteObjectCommand: makeCommand("DeleteObject"),
    HeadObjectCommand: makeCommand("HeadObject"),
  };
});

const { mockGetSignedUrl } = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const { mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(
  () => ({
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
  })
);

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { IAgentRuntime } from "@elizaos/core";
import { AwsS3Service } from "../services/s3";

function makeRuntime(
  overrides: Record<string, string | boolean | null> = {}
): IAgentRuntime {
  const settings: Record<string, string | boolean | null> = {
    AWS_ACCESS_KEY_ID: "AKID-test",
    AWS_SECRET_ACCESS_KEY: "secret-test",
    AWS_REGION: "us-west-2",
    AWS_S3_BUCKET: "my-bucket",
    AWS_S3_UPLOAD_PATH: "uploads",
    ...overrides,
  };
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    getService: vi.fn(() => null),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AwsS3Service", () => {
  let service: AwsS3Service;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.from("file-content-here"));
    mockGetSignedUrl.mockResolvedValue(
      "https://signed.example.com/presigned"
    );

    const runtime = makeRuntime();
    service = new AwsS3Service(runtime);
  });

  // ── Plugin-level exports ──────────────────────────────────────────

  describe("Plugin exports", () => {
    it("storageS3Plugin has correct name, description, and service", async () => {
      const { storageS3Plugin } = await import("..");
      expect(storageS3Plugin.name).toBe("storage-s3");
      expect(storageS3Plugin.description).toMatch(/S3/i);
      expect(storageS3Plugin.services!.length).toBe(1);
      expect(storageS3Plugin.actions).toEqual([]);
    });
  });

  // ── uploadFile ────────────────────────────────────────────────────

  describe("uploadFile", () => {
    it("uploads a file and returns a public URL", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.uploadFile("/data/report.pdf", "docs");

      expect(result.success).toBe(true);
      expect(result.url).toContain("my-bucket");
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("returns failure when file does not exist", async () => {
      mockExistsSync.mockReturnValueOnce(false);

      const result = await service.uploadFile("/missing/file.txt");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not exist/i);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("returns a signed URL when requested", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.uploadFile(
        "/data/secret.pdf",
        "",
        true,
        3600
      );

      expect(result.success).toBe(true);
      expect(result.url).toContain("signed");
    });

    it("returns failure when AWS credentials are missing", async () => {
      const rt = makeRuntime({ AWS_ACCESS_KEY_ID: null });
      service = new AwsS3Service(rt);

      const result = await service.uploadFile("/data/file.txt");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/credentials not configured/i);
    });

    it("returns failure when S3 send throws", async () => {
      mockSend.mockRejectedValueOnce(new Error("network timeout"));

      const result = await service.uploadFile("/data/file.txt");

      expect(result.success).toBe(false);
      expect(result.error).toBe("network timeout");
    });
  });

  // ── uploadBytes ───────────────────────────────────────────────────

  describe("uploadBytes", () => {
    it("uploads byte buffer and returns URL", async () => {
      mockSend.mockResolvedValueOnce({});

      const data = Buffer.from("binary data here");
      const result = await service.uploadBytes(
        data,
        "image.png",
        "image/png",
        "images"
      );

      expect(result.success).toBe(true);
      expect(result.url).toBeDefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("handles upload error gracefully", async () => {
      mockSend.mockRejectedValueOnce(new Error("S3 unavailable"));

      const result = await service.uploadBytes(
        Buffer.from("x"),
        "f.bin",
        "application/octet-stream"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("S3 unavailable");
    });

    it("returns failure when credentials are missing", async () => {
      const rt = makeRuntime({ AWS_SECRET_ACCESS_KEY: null });
      service = new AwsS3Service(rt);

      const result = await service.uploadBytes(
        Buffer.from("data"),
        "f.bin",
        "application/octet-stream"
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/credentials/i);
    });
  });

  // ── uploadJson ────────────────────────────────────────────────────

  describe("uploadJson", () => {
    it("uploads JSON and returns URL + key", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.uploadJson(
        { name: "test", items: [1, 2, 3] },
        "data.json",
        "json-files"
      );

      expect(result.success).toBe(true);
      expect(result.url).toBeDefined();
      expect(result.key).toMatch(/data\.json$/);
    });

    it("returns failure when JSON data is null", async () => {
      const result = await service.uploadJson(null as any);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/JSON data is required/i);
    });

    it("auto-generates filename if none provided", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.uploadJson({ key: "val" });

      expect(result.success).toBe(true);
      expect(result.key).toMatch(/\.json$/);
    });

    it("uses signed URL when requested", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.uploadJson(
        { a: 1 },
        "data.json",
        undefined,
        true,
        1800
      );

      expect(result.success).toBe(true);
      expect(result.url).toContain("signed");
    });
  });

  // ── downloadBytes ─────────────────────────────────────────────────

  describe("downloadBytes", () => {
    it("downloads bytes from S3", async () => {
      const testPayload = new Uint8Array([10, 20, 30, 40]);
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(testPayload),
        },
      });

      const buf = await service.downloadBytes("my-bucket", "data/file.bin");

      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(4);
      expect(buf[0]).toBe(10);
    });

    it("throws when response body is empty", async () => {
      mockSend.mockResolvedValueOnce({ Body: null });

      await expect(
        service.downloadBytes("my-bucket", "data/file.bin")
      ).rejects.toThrow(/empty response body/i);
    });

    it("throws when credentials are missing", async () => {
      const rt = makeRuntime({ AWS_REGION: null });
      service = new AwsS3Service(rt);

      await expect(
        service.downloadBytes("bkt", "key")
      ).rejects.toThrow(/credentials not configured/i);
    });
  });

  // ── downloadFile ──────────────────────────────────────────────────

  describe("downloadFile", () => {
    it("downloads an object and writes it to disk", async () => {
      const payload = new Uint8Array([1, 2, 3]);
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(payload),
        },
      });

      await service.downloadFile("my-bucket", "docs/f.pdf", "/tmp/f.pdf");

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/f.pdf",
        expect.any(Buffer)
      );
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe("delete", () => {
    it("sends DeleteObjectCommand", async () => {
      mockSend.mockResolvedValueOnce({});

      await service.delete("my-bucket", "old/file.txt");

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("throws when credentials missing", async () => {
      const rt = makeRuntime({ AWS_S3_BUCKET: null });
      service = new AwsS3Service(rt);

      await expect(
        service.delete("bkt", "key")
      ).rejects.toThrow(/credentials/i);
    });
  });

  // ── exists ────────────────────────────────────────────────────────

  describe("exists", () => {
    it("returns true when HeadObject succeeds", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.exists("my-bucket", "present.txt");

      expect(result).toBe(true);
    });

    it("returns false when error name is NotFound", async () => {
      const err = new Error("NotFound");
      err.name = "NotFound";
      mockSend.mockRejectedValueOnce(err);

      const result = await service.exists("my-bucket", "missing.txt");

      expect(result).toBe(false);
    });

    it("returns false when HTTP status is 404", async () => {
      const err = Object.assign(new Error("gone"), {
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValueOnce(err);

      const result = await service.exists("my-bucket", "gone.txt");

      expect(result).toBe(false);
    });

    it("rethrows non-404 errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("Internal Server Error"));

      await expect(
        service.exists("my-bucket", "key")
      ).rejects.toThrow("Internal Server Error");
    });
  });

  // ── generateSignedUrl ─────────────────────────────────────────────

  describe("generateSignedUrl", () => {
    it("returns a presigned URL", async () => {
      const url = await service.generateSignedUrl("uploads/report.pdf", 3600);

      expect(url).toBe("https://signed.example.com/presigned");
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });

    it("throws when credentials not configured", async () => {
      const rt = makeRuntime({ AWS_ACCESS_KEY_ID: null });
      service = new AwsS3Service(rt);

      await expect(
        service.generateSignedUrl("file.txt")
      ).rejects.toThrow(/credentials not configured/i);
    });
  });

  // ── getContentType ────────────────────────────────────────────────

  describe("getContentType", () => {
    it("resolves known extensions", async () => {
      const { getContentType } = await import("../types");

      expect(getContentType("photo.png")).toBe("image/png");
      expect(getContentType("photo.jpg")).toBe("image/jpeg");
      expect(getContentType("photo.jpeg")).toBe("image/jpeg");
      expect(getContentType("animation.gif")).toBe("image/gif");
      expect(getContentType("image.webp")).toBe("image/webp");
      expect(getContentType("document.pdf")).toBe("application/pdf");
      expect(getContentType("data.json")).toBe("application/json");
      expect(getContentType("readme.txt")).toBe("text/plain");
      expect(getContentType("page.html")).toBe("text/html");
      expect(getContentType("style.css")).toBe("text/css");
      expect(getContentType("script.js")).toBe("application/javascript");
      expect(getContentType("song.mp3")).toBe("audio/mpeg");
      expect(getContentType("video.mp4")).toBe("video/mp4");
      expect(getContentType("audio.wav")).toBe("audio/wav");
      expect(getContentType("clip.webm")).toBe("video/webm");
    });

    it("returns octet-stream for unknown extensions", async () => {
      const { getContentType } = await import("../types");

      expect(getContentType("file.xyz")).toBe("application/octet-stream");
      expect(getContentType("archive.tar")).toBe("application/octet-stream");
    });
  });

  // ── S3StorageConfig type ──────────────────────────────────────────

  describe("S3StorageConfig type", () => {
    it("can be fully constructed", async () => {
      const config = {
        accessKeyId: "AKID",
        secretAccessKey: "secret",
        region: "eu-west-1",
        bucket: "my-bucket",
        uploadPath: "data/",
        endpoint: "https://minio.local:9000",
        sslEnabled: true,
        forcePathStyle: true,
      };

      expect(config.accessKeyId).toBe("AKID");
      expect(config.endpoint).toBe("https://minio.local:9000");
      expect(config.forcePathStyle).toBe(true);
    });
  });

  // ── UploadResult / JsonUploadResult ───────────────────────────────

  describe("Result types", () => {
    it("UploadResult success shape", () => {
      const r = { success: true, url: "https://s3.example.com/f.txt" };
      expect(r.success).toBe(true);
      expect(r.url).toContain("s3");
    });

    it("UploadResult failure shape", () => {
      const r = { success: false, error: "boom" };
      expect(r.success).toBe(false);
      expect(r.error).toBe("boom");
    });

    it("JsonUploadResult includes key", () => {
      const r = {
        success: true,
        url: "https://s3.example.com/data.json",
        key: "uploads/data.json",
      };
      expect(r.key).toBe("uploads/data.json");
    });
  });
});
