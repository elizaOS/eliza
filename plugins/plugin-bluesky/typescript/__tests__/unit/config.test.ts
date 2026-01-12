import { describe, expect, it } from "vitest";
import { BLUESKY_MAX_POST_LENGTH, BLUESKY_SERVICE_URL, BlueSkyConfigSchema } from "../../types";

describe("BlueSkyConfigSchema", () => {
  it("should validate a valid config", () => {
    const config = {
      handle: "test.bsky.social",
      password: "test-password",
    };

    const result = BlueSkyConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should validate config with optional fields", () => {
    const config = {
      handle: "test.bsky.social",
      password: "test-password",
      service: "https://custom.bsky.social",
      dryRun: true,
      pollInterval: 120,
    };

    const result = BlueSkyConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should reject invalid handle format", () => {
    const config = {
      handle: "invalid",
      password: "test-password",
    };

    const result = BlueSkyConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject empty password", () => {
    const config = {
      handle: "test.bsky.social",
      password: "",
    };

    const result = BlueSkyConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should accept multi-level handles", () => {
    const config = {
      handle: "user.subdomain.bsky.social",
      password: "test-password",
    };

    const result = BlueSkyConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe("Constants", () => {
  it("should have correct default service URL", () => {
    expect(BLUESKY_SERVICE_URL).toBe("https://bsky.social");
  });

  it("should have correct max post length", () => {
    expect(BLUESKY_MAX_POST_LENGTH).toBe(300);
  });
});
