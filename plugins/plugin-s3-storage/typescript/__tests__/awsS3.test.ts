import { describe, expect, it } from "vitest";

describe("AwsS3Service", () => {
  it("should export AwsS3Service class", async () => {
    const { AwsS3Service } = await import("../services/s3");
    expect(AwsS3Service).toBeDefined();
    expect(typeof AwsS3Service).toBe("function");
  });

  it("should have correct service type", async () => {
    const { AwsS3Service } = await import("../services/s3");
    expect(AwsS3Service.serviceType).toBe("aws_s3");
  });

  it("should have static start method", async () => {
    const { AwsS3Service } = await import("../services/s3");
    expect(typeof AwsS3Service.start).toBe("function");
  });

  it("should have static stop method", async () => {
    const { AwsS3Service } = await import("../services/s3");
    expect(typeof AwsS3Service.stop).toBe("function");
  });
});
