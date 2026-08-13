/**
 * Exercises the apps-deploy startup image inventory with injected persisted rows
 * and operator configuration, without connecting to the repository database.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { assertAppsDeployImagesImmutable } from "../app-deploy-image-preflight";

const PINNED = `ghcr.io/elizaos/app@sha256:a${"0".repeat(63)}`;
const app = (id: string, name: string, imageTag?: unknown) => ({
  id,
  name,
  metadata: imageTag === undefined ? {} : { imageTag },
});

describe("assertAppsDeployImagesImmutable", () => {
  test("passes when all sources are absent", async () => {
    await expect(
      assertAppsDeployImagesImmutable({ env: {}, listApps: async () => [] }),
    ).resolves.toBeUndefined();
  });

  test("passes digest-pinned defaults, map entries, and persisted refs", async () => {
    await expect(
      assertAppsDeployImagesImmutable({
        env: {
          APP_DEFAULT_IMAGE: PINNED,
          APP_DEFAULT_TEMPLATE_IMAGE: PINNED,
          APP_PREBUILT_IMAGES: JSON.stringify({ Showcase: PINNED }),
        },
        listApps: async () => [app("app-1", "Pinned", PINNED)],
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects a mutable APP_DEFAULT_IMAGE", async () => {
    await expect(
      assertAppsDeployImagesImmutable({
        env: { APP_DEFAULT_IMAGE: "ghcr.io/elizaos/app:latest" },
        listApps: async () => [],
      }),
    ).rejects.toMatchObject({
      code: "APPS_DEPLOY_IMAGE_PREFLIGHT_FAILED",
      message: expect.stringContaining("APP_DEFAULT_IMAGE"),
    });
  });

  test("rejects malformed and non-object APP_PREBUILT_IMAGES", async () => {
    for (const raw of ["not-json", "[]"]) {
      await expect(
        assertAppsDeployImagesImmutable({
          env: { APP_PREBUILT_IMAGES: raw },
          listApps: async () => [],
        }),
      ).rejects.toMatchObject({ code: "APPS_DEPLOY_IMAGE_PREFLIGHT_FAILED" });
    }
  });

  test("identifies a mutable APP_PREBUILT_IMAGES prefix", async () => {
    await expect(
      assertAppsDeployImagesImmutable({
        env: {
          APP_PREBUILT_IMAGES: JSON.stringify({
            "Mutable Showcase": "ghcr.io/elizaos/app:showcase",
          }),
        },
        listApps: async () => [],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('APP_PREBUILT_IMAGES["Mutable Showcase"]'),
    });
  });

  test("aggregates mutable and malformed persisted image tags", async () => {
    let failure: unknown;
    try {
      await assertAppsDeployImagesImmutable({
        env: {},
        listApps: async () => [
          app("app-mutable", "Mutable", "ghcr.io/elizaos/app:v1"),
          app("app-malformed", "Malformed", 42),
          app("app-pinned", "Pinned", PINNED),
        ],
      });
    } catch (error) {
      // error-policy:J1 the test boundary captures the typed failure for one
      // complete aggregate assertion.
      failure = error;
    }

    expect(failure).toBeInstanceOf(ElizaError);
    const typedFailure = failure as ElizaError;
    expect(typedFailure.code).toBe("APPS_DEPLOY_IMAGE_PREFLIGHT_FAILED");
    expect(typedFailure.message).toContain("app-mutable");
    expect(typedFailure.message).toContain("app-malformed");
    const violations = typedFailure.context?.violations as string[];
    expect(violations.some((violation) => violation.includes("app-mutable"))).toBe(true);
    expect(violations.some((violation) => violation.includes("app-malformed"))).toBe(true);
  });

  test("rejects a mutable APP_DEFAULT_TEMPLATE_IMAGE override", async () => {
    await expect(
      assertAppsDeployImagesImmutable({
        env: { APP_DEFAULT_TEMPLATE_IMAGE: "ghcr.io/elizaos/example-edad:showcase" },
        listApps: async () => [],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("APP_DEFAULT_TEMPLATE_IMAGE"),
    });
  });
});
