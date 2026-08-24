/**
 * Pins the app-deployment-generation metadata contract: only a persisted
 * valid UUID generation round-trips, invalid or legacy metadata reads as
 * null, and writes reject non-UUID generations while preserving unrelated
 * metadata keys.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_DEPLOYMENT_GENERATION_KEY,
  deploymentGenerationFromMetadata,
  metadataForDeploymentGeneration,
} from "./app-deployment-generation";

const VALID_GENERATION = "3f7f4c9e-1a2b-4c3d-8e5f-6a7b8c9d0e1f";

describe("deploymentGenerationFromMetadata", () => {
  test("returns the persisted generation when it is a valid UUID", () => {
    expect(
      deploymentGenerationFromMetadata({ [APP_DEPLOYMENT_GENERATION_KEY]: VALID_GENERATION }),
    ).toBe(VALID_GENERATION);
  });

  test("accepts an uppercase UUID (regex is case-insensitive)", () => {
    expect(
      deploymentGenerationFromMetadata({
        [APP_DEPLOYMENT_GENERATION_KEY]: VALID_GENERATION.toUpperCase(),
      }),
    ).toBe(VALID_GENERATION.toUpperCase());
  });

  test("returns null when the key is absent", () => {
    expect(deploymentGenerationFromMetadata({})).toBeNull();
    expect(deploymentGenerationFromMetadata({ other: "value" })).toBeNull();
  });

  test("returns null for null or undefined metadata", () => {
    expect(deploymentGenerationFromMetadata(null)).toBeNull();
    expect(deploymentGenerationFromMetadata(undefined)).toBeNull();
  });

  test("returns null for non-string values", () => {
    expect(deploymentGenerationFromMetadata({ [APP_DEPLOYMENT_GENERATION_KEY]: 42 })).toBeNull();
    expect(deploymentGenerationFromMetadata({ [APP_DEPLOYMENT_GENERATION_KEY]: null })).toBeNull();
  });

  test("returns null for malformed UUID strings", () => {
    expect(
      deploymentGenerationFromMetadata({ [APP_DEPLOYMENT_GENERATION_KEY]: "not-a-uuid" }),
    ).toBeNull();
    expect(
      deploymentGenerationFromMetadata({
        [APP_DEPLOYMENT_GENERATION_KEY]: "3f7f4c9e-1a2b-4c3d-8e5f-6a7b8c9d0e1", // truncated
      }),
    ).toBeNull();
    // Version digit outside 1-5 is rejected (v6+ UUIDs are not supported).
    expect(
      deploymentGenerationFromMetadata({
        [APP_DEPLOYMENT_GENERATION_KEY]: "3f7f4c9e-1a2b-6c3d-8e5f-6a7b8c9d0e1f",
      }),
    ).toBeNull();
  });
});

describe("metadataForDeploymentGeneration", () => {
  test("throws on a non-UUID generation", () => {
    expect(() => metadataForDeploymentGeneration({}, "not-a-uuid")).toThrow(
      "Invalid app deployment generation",
    );
    expect(() => metadataForDeploymentGeneration({}, "")).toThrow(
      "Invalid app deployment generation",
    );
  });

  test("writes the generation key onto empty metadata", () => {
    expect(metadataForDeploymentGeneration(null, VALID_GENERATION)).toEqual({
      [APP_DEPLOYMENT_GENERATION_KEY]: VALID_GENERATION,
    });
    expect(metadataForDeploymentGeneration(undefined, VALID_GENERATION)).toEqual({
      [APP_DEPLOYMENT_GENERATION_KEY]: VALID_GENERATION,
    });
  });

  test("preserves unrelated metadata while binding the generation", () => {
    const result = metadataForDeploymentGeneration(
      { name: "my-app", region: "us-east-1" },
      VALID_GENERATION,
    );
    expect(result).toEqual({
      name: "my-app",
      region: "us-east-1",
      [APP_DEPLOYMENT_GENERATION_KEY]: VALID_GENERATION,
    });
  });

  test("overwrites a stale generation value", () => {
    const result = metadataForDeploymentGeneration(
      { [APP_DEPLOYMENT_GENERATION_KEY]: "legacy", name: "my-app" },
      VALID_GENERATION,
    );
    expect(result).toEqual({
      [APP_DEPLOYMENT_GENERATION_KEY]: VALID_GENERATION,
      name: "my-app",
    });
  });
});
