/**
 * Unit tests for the app build script's build-info stamp gate. The stamp is a
 * staging/debug affordance, so production and store builds must delete it even
 * when the checkout has a `.git` directory.
 */
import { describe, expect, it } from "vitest";
import {
  removeEmittedBuildStamp,
  shouldSkipBuildStamp,
} from "./build-stamp.mjs";

const env = (overrides = {}) => ({
  ELIZA_BUILD_STAMP: undefined,
  ELIZA_BUILD_VARIANT: undefined,
  ELIZA_RELEASE_AUTHORITY: undefined,
  VITE_ENVIRONMENT: undefined,
  ...overrides,
});

describe("shouldSkipBuildStamp", () => {
  it("skips the stamp for Cloudflare production builds", () => {
    expect(shouldSkipBuildStamp(env({ VITE_ENVIRONMENT: "production" }))).toBe(
      true,
    );
  });

  it("skips the stamp for direct Vite production builds", () => {
    expect(shouldSkipBuildStamp(env(), { viteMode: "production" })).toBe(true);
  });

  it("skips the stamp for app-store builds", () => {
    expect(shouldSkipBuildStamp(env({ ELIZA_BUILD_VARIANT: "store" }))).toBe(
      true,
    );
    expect(shouldSkipBuildStamp(env({ ELIZA_BUILD_VARIANT: "STORE" }))).toBe(
      true,
    );
    expect(
      shouldSkipBuildStamp(env({ ELIZA_RELEASE_AUTHORITY: "apple-app-store" })),
    ).toBe(true);
  });

  it("keeps the stamp for staging, direct, and developer-toolchain builds", () => {
    expect(shouldSkipBuildStamp(env({ VITE_ENVIRONMENT: "staging" }))).toBe(
      false,
    );
    expect(shouldSkipBuildStamp(env(), { viteMode: "staging" })).toBe(false);
    expect(shouldSkipBuildStamp(env({ ELIZA_BUILD_VARIANT: "direct" }))).toBe(
      false,
    );
    expect(
      shouldSkipBuildStamp(
        env({ ELIZA_RELEASE_AUTHORITY: "developer-toolchain" }),
      ),
    ).toBe(false);
  });

  it("skips the stamp for bare Vite production builds", () => {
    expect(shouldSkipBuildStamp(env(), { viteProductionBuild: true })).toBe(
      true,
    );
  });

  it("keeps the stamp for explicitly non-production Vite builds", () => {
    expect(
      shouldSkipBuildStamp(env({ VITE_ENVIRONMENT: "staging" }), {
        viteProductionBuild: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipBuildStamp(env({ ELIZA_BUILD_VARIANT: "direct" }), {
        viteProductionBuild: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipBuildStamp(
        env({ ELIZA_RELEASE_AUTHORITY: "developer-toolchain" }),
        { viteProductionBuild: true },
      ),
    ).toBe(false);
  });

  it("allows forced stamp debugging even in production", () => {
    expect(
      shouldSkipBuildStamp(
        env({ ELIZA_BUILD_STAMP: "1", VITE_ENVIRONMENT: "production" }),
      ),
    ).toBe(false);
    expect(
      shouldSkipBuildStamp(env({ ELIZA_BUILD_STAMP: "1" }), {
        viteProductionBuild: true,
      }),
    ).toBe(false);
  });

  it("removes emitted build-info assets from Vite production bundles", () => {
    const bundle = {
      "assets/app.js": { type: "chunk" },
      "build-info.json": { type: "asset" },
      "/build-info.json": { type: "asset" },
    };

    removeEmittedBuildStamp(bundle);

    expect(bundle).toEqual({ "assets/app.js": { type: "chunk" } });
  });
});
