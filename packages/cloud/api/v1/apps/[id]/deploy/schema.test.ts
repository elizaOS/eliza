import { describe, expect, test } from "bun:test";
import { DeployBodySchema } from "./schema";

describe("DeployBodySchema", () => {
  test("accepts an explicit prebuilt image with existing deploy options", () => {
    const input = {
      image: "ghcr.io/elizaos/custom-app@sha256:abc",
      env: { FEATURE_FLAG: "1" },
    };
    expect(DeployBodySchema.parse(input)).toEqual(input);
  });

  test("rejects blank and oversized image references", () => {
    expect(DeployBodySchema.safeParse({ image: "   " }).success).toBe(false);
    expect(
      DeployBodySchema.safeParse({ image: "a".repeat(1025) }).success,
    ).toBe(false);
  });
});
