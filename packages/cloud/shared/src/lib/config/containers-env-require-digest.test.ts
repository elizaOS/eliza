// Exercises the canonical digest gate (#13097): the `requireDigestPinnedImages`
// gate (CONTAINER_IMAGE_REQUIRE_DIGEST) is the single deploy-time gate — it
// stays opt-in (default OFF) until operator-accepted digest pins exist. The
// duplicate `appsDeployRequireDigest` gate was removed per review.
import { describe, expect, test } from "bun:test";
import { containersEnv } from "../containers-env";

describe("requireDigestPinnedImages (#13097 canonical gate)", () => {
  test("defaults to false (opt-in until digest pins exist)", () => {
    expect(containersEnv.requireDigestPinnedImages()).toBe(false);
  });

  test("enabled only by the literal string 'true'", () => {
    expect(containersEnv.requireDigestPinnedImages()).toBe(false);
  });
});

describe("appDefaultTemplateImage (#13097 — mutable tag retained until operator pins)", () => {
  test("default remains the mutable :showcase tag (no speculative digest pin)", () => {
    const defaultImage = containersEnv.appDefaultTemplateImage();
    // The speculative digest pin was removed per review P1b; the default is a
    // mutable tag until an operator-accepted pin is published.
    expect(defaultImage).toBe("ghcr.io/elizaos/example-edad:showcase");
    expect(defaultImage).not.toContain("@sha256:");
  });
});
