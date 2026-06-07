import { describe, expect, test } from "bun:test";
import { appImageSlug, buildAppImageRef, deriveImageTag } from "../app-image-ref";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("appImageSlug", () => {
  test("strips to [a-z0-9], lowercases, caps at 24", () => {
    expect(appImageSlug(APP)).toBe("aaaaaaaaaaaa4aaa8aaaaaaa");
    expect(appImageSlug("ABC-123-def-456-ghi")).toBe("abc123def456ghi");
  });

  test("throws on a too-short slug", () => {
    expect(() => appImageSlug("a-b-c")).toThrow(/too short/);
  });
});

describe("deriveImageTag", () => {
  test("absent/empty ref → latest", () => {
    expect(deriveImageTag()).toBe("latest");
    expect(deriveImageTag("")).toBe("latest");
  });

  test("passes through a clean git sha", () => {
    expect(deriveImageTag("a1b2c3d")).toBe("a1b2c3d");
  });

  test("collapses unsafe chars and strips a leading dot/dash", () => {
    expect(deriveImageTag("feature/cool branch")).toBe("feature-cool-branch");
    expect(deriveImageTag("-.weird")).toBe("weird");
  });

  test("caps at 128 chars", () => {
    expect(deriveImageTag("x".repeat(200)).length).toBe(128);
  });
});

describe("buildAppImageRef", () => {
  test("composes <registry>/app-<slug>:<tag>", () => {
    expect(
      buildAppImageRef({ registry: "ghcr.io/elizaos", appId: APP, sourceRef: "a1b2c3d" }),
    ).toBe("ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d");
  });

  test("defaults tag to latest and trims trailing slashes on the registry", () => {
    expect(buildAppImageRef({ registry: "registry.local:5000/apps/", appId: APP })).toBe(
      "registry.local:5000/apps/app-aaaaaaaaaaaa4aaa8aaaaaaa:latest",
    );
  });

  test("rejects an invalid registry", () => {
    expect(() => buildAppImageRef({ registry: "bad registry!", appId: APP })).toThrow(
      /invalid registry/,
    );
  });
});
