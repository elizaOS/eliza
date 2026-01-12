import { describe, expect, it } from "vitest";

describe("Storage S3 Plugin", () => {
  it("should export the plugin from index", async () => {
    const { storageS3Plugin } = await import("..");
    expect(storageS3Plugin).toBeDefined();
    expect(storageS3Plugin.name).toBe("storage-s3");
    expect(storageS3Plugin.description).toBe(
      "Plugin for file storage in AWS S3 and S3-compatible services"
    );
  });

  it("should export the AwsS3Service", async () => {
    const { AwsS3Service } = await import("../services/s3");
    expect(AwsS3Service).toBeDefined();
    expect(AwsS3Service.serviceType).toBe("aws_s3");
  });

  it("should register the AwsS3Service in plugin", async () => {
    const { storageS3Plugin } = await import("..");
    expect(storageS3Plugin.services).toBeDefined();
    expect(storageS3Plugin.services?.length).toBeGreaterThan(0);
  });

  it("should have no actions", async () => {
    const { storageS3Plugin } = await import("..");
    expect(storageS3Plugin.actions).toEqual([]);
  });
});
