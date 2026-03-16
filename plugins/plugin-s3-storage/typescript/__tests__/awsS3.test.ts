import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock helpers – available before vi.mock factories run
// ---------------------------------------------------------------------------
const mockSend = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("@aws-sdk/client-s3", () => {
  // All constructors must be regular functions / classes so they work with `new`
  function MockS3Client() {
    return { send: mockSend, destroy: mockDestroy, config: {} };
  }
  class MockGetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockPutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockDeleteObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockHeadObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: MockS3Client,
    GetObjectCommand: MockGetObjectCommand,
    PutObjectCommand: MockPutObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
    HeadObjectCommand: MockHeadObjectCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://signed-url.example.com"),
}));

const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockReadFileSync = vi.hoisted(() => vi.fn(() => Buffer.from("test content")));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
}));

vi.mock("@elizaos/core", () => ({
  Service: class {
    runtime: unknown;
    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  },
  ServiceType: { REMOTE_FILES: "aws_s3" },
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (resolved to mocked versions)
// ---------------------------------------------------------------------------
import { AwsS3Service } from "../services/s3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createMockRuntime() {
  return {
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        AWS_ACCESS_KEY_ID: "test-key-id",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_REGION: "us-east-1",
        AWS_S3_BUCKET: "test-bucket",
        AWS_S3_UPLOAD_PATH: "uploads/",
      };
      return settings[key] ?? null;
    }),
    getService: vi.fn(),
  } as any;
}

function createMockRuntimeMissingCreds() {
  return {
    getSetting: vi.fn(() => null),
    getService: vi.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("AwsS3Service", () => {
  // -- Basic export tests (kept from original) --------------------------------
  describe("exports", () => {
    it("should export AwsS3Service class", () => {
      expect(AwsS3Service).toBeDefined();
      expect(typeof AwsS3Service).toBe("function");
    });

    it("should have static start method", () => {
      expect(typeof AwsS3Service.start).toBe("function");
    });

    it("should have static stop method", () => {
      expect(typeof AwsS3Service.stop).toBe("function");
    });
  });

  // -- downloadBytes ----------------------------------------------------------
  describe("downloadBytes", () => {
    let service: AwsS3Service;

    beforeEach(() => {
      vi.clearAllMocks();
      service = new AwsS3Service(createMockRuntime());
    });

    it("should download object and return a Buffer", async () => {
      const payload = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(payload),
        },
      });

      const result = await service.downloadBytes("my-bucket", "path/to/file.txt");

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input).toEqual({
        Bucket: "my-bucket",
        Key: "path/to/file.txt",
      });
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe("Hello");
    });

    it("should throw when response body is empty", async () => {
      mockSend.mockResolvedValueOnce({ Body: undefined });

      await expect(service.downloadBytes("b", "k")).rejects.toThrow(
        "Empty response body from S3"
      );
    });

    it("should throw when AWS credentials are not configured", async () => {
      const badService = new AwsS3Service(createMockRuntimeMissingCreds());

      await expect(badService.downloadBytes("b", "k")).rejects.toThrow(
        "AWS S3 credentials not configured"
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should propagate S3 SDK errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("Access Denied"));

      await expect(
        service.downloadBytes("my-bucket", "secret.txt")
      ).rejects.toThrow("Access Denied");
    });
  });

  // -- downloadFile -----------------------------------------------------------
  describe("downloadFile", () => {
    let service: AwsS3Service;

    beforeEach(() => {
      vi.clearAllMocks();
      service = new AwsS3Service(createMockRuntime());
    });

    it("should download object and write it to a local file", async () => {
      const payload = new Uint8Array([1, 2, 3, 4]);
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(payload),
        },
      });

      await service.downloadFile("my-bucket", "data/file.bin", "/tmp/file.bin");

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input).toEqual({
        Bucket: "my-bucket",
        Key: "data/file.bin",
      });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/file.bin",
        expect.any(Buffer)
      );
      // Verify the written buffer matches
      const writtenBuffer = mockWriteFileSync.mock.calls[0][1] as Buffer;
      expect([...writtenBuffer]).toEqual([1, 2, 3, 4]);
    });

    it("should propagate errors from downloadBytes", async () => {
      mockSend.mockRejectedValueOnce(new Error("NoSuchKey"));

      await expect(
        service.downloadFile("my-bucket", "missing.txt", "/tmp/missing.txt")
      ).rejects.toThrow("NoSuchKey");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("should throw when credentials are missing", async () => {
      const badService = new AwsS3Service(createMockRuntimeMissingCreds());

      await expect(
        badService.downloadFile("b", "k", "/tmp/out")
      ).rejects.toThrow("AWS S3 credentials not configured");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  // -- delete -----------------------------------------------------------------
  describe("delete", () => {
    let service: AwsS3Service;

    beforeEach(() => {
      vi.clearAllMocks();
      service = new AwsS3Service(createMockRuntime());
    });

    it("should send DeleteObjectCommand with correct params", async () => {
      mockSend.mockResolvedValueOnce({});

      await service.delete("my-bucket", "path/to/object.json");

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input).toEqual({
        Bucket: "my-bucket",
        Key: "path/to/object.json",
      });
    });

    it("should resolve without returning a value", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await service.delete("my-bucket", "key");
      expect(result).toBeUndefined();
    });

    it("should throw when credentials are not configured", async () => {
      const badService = new AwsS3Service(createMockRuntimeMissingCreds());

      await expect(badService.delete("b", "k")).rejects.toThrow(
        "AWS S3 credentials not configured"
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should propagate S3 SDK errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("Internal Server Error"));

      await expect(
        service.delete("my-bucket", "path/key")
      ).rejects.toThrow("Internal Server Error");
    });
  });

  // -- exists -----------------------------------------------------------------
  describe("exists", () => {
    let service: AwsS3Service;

    beforeEach(() => {
      vi.clearAllMocks();
      service = new AwsS3Service(createMockRuntime());
    });

    it("should return true when the object exists", async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 1024,
        ContentType: "application/octet-stream",
      });

      const result = await service.exists("my-bucket", "path/to/file.txt");

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input).toEqual({
        Bucket: "my-bucket",
        Key: "path/to/file.txt",
      });
      expect(result).toBe(true);
    });

    it("should return false when HeadObject throws NotFound", async () => {
      const notFound = new Error("Not Found");
      notFound.name = "NotFound";
      mockSend.mockRejectedValueOnce(notFound);

      const result = await service.exists("my-bucket", "no-such-key");

      expect(result).toBe(false);
    });

    it("should return false when HeadObject returns 404 via $metadata", async () => {
      const error = Object.assign(new Error("not found"), {
        name: "UnknownError",
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValueOnce(error);

      const result = await service.exists("my-bucket", "no-such-key");

      expect(result).toBe(false);
    });

    it("should throw on non-404 errors", async () => {
      mockSend.mockRejectedValueOnce(new Error("Access Denied"));

      await expect(
        service.exists("my-bucket", "secret-key")
      ).rejects.toThrow("Access Denied");
    });

    it("should throw when credentials are not configured", async () => {
      const badService = new AwsS3Service(createMockRuntimeMissingCreds());

      await expect(badService.exists("b", "k")).rejects.toThrow(
        "AWS S3 credentials not configured"
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
