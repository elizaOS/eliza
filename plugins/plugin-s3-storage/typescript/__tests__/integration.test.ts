import { describe, expect, it } from "vitest";

const HAS_AWS_CREDS = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.AWS_S3_BUCKET
);
const _skipIfNoCreds = HAS_AWS_CREDS ? it : it.skip;

describe("S3 Storage Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export storageS3Plugin", async () => {
      const { storageS3Plugin } = await import("../index");
      expect(storageS3Plugin).toBeDefined();
      expect(storageS3Plugin.name).toBe("storage-s3");
    });

    it("should have correct description", async () => {
      const { storageS3Plugin } = await import("../index");
      expect(storageS3Plugin.description).toContain("S3");
    });

    it("should have services defined", async () => {
      const { storageS3Plugin } = await import("../index");
      expect(storageS3Plugin.services).toBeDefined();
      expect(Array.isArray(storageS3Plugin.services)).toBe(true);
      expect(storageS3Plugin.services?.length).toBeGreaterThan(0);
    });

    it("should have empty actions array", async () => {
      const { storageS3Plugin } = await import("../index");
      expect(storageS3Plugin.actions).toEqual([]);
    });
  });

  describe("Service", () => {
    it("should export AwsS3Service", async () => {
      const { AwsS3Service } = await import("../services/s3");
      expect(AwsS3Service).toBeDefined();
    });

    it("should be a valid service class", async () => {
      const { AwsS3Service } = await import("../services/s3");
      expect(AwsS3Service.serviceType).toBe("aws_s3");
    });
  });

  describe("Types", () => {
    it("should export FileLocationResultSchema", async () => {
      const { FileLocationResultSchema } = await import("../types");
      expect(FileLocationResultSchema).toBeDefined();
    });

    it("should export isFileLocationResult", async () => {
      const { isFileLocationResult } = await import("../types");
      expect(typeof isFileLocationResult).toBe("function");
    });

    it("should validate valid FileLocationResult", async () => {
      const { isFileLocationResult } = await import("../types");
      const validResult = { fileLocation: "s3://bucket/path/to/file.jpg" };
      expect(isFileLocationResult(validResult)).toBe(true);
    });

    it("should reject invalid FileLocationResult", async () => {
      const { isFileLocationResult } = await import("../types");
      expect(isFileLocationResult(null)).toBe(false);
      expect(isFileLocationResult({})).toBe(false);
      expect(isFileLocationResult({ fileLocation: "" })).toBe(false);
    });
  });
});
