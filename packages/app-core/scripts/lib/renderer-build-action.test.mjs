/** Exercises renderer build action behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { resolveRendererBuildAction } from "./renderer-build-action.mjs";

describe("resolveRendererBuildAction", () => {
  it("builds when forced, even if the dist is fresh", () => {
    expect(
      resolveRendererBuildAction({
        forceRenderer: true,
        distStale: false,
        distExists: true,
        skipRequested: false,
      }),
    ).toBe("build");
  });

  it("skips a fresh dist", () => {
    expect(
      resolveRendererBuildAction({
        forceRenderer: false,
        distStale: false,
        distExists: true,
        skipRequested: false,
      }),
    ).toBe("skip-fresh");
  });

  it("builds a stale dist by default", () => {
    expect(
      resolveRendererBuildAction({
        forceRenderer: false,
        distStale: true,
        distExists: true,
        skipRequested: false,
      }),
    ).toBe("build");
  });

  it("honors an explicit skip of a stale build when a dist exists", () => {
    expect(
      resolveRendererBuildAction({
        forceRenderer: false,
        distStale: true,
        distExists: true,
        skipRequested: true,
      }),
    ).toBe("skip-stale");
  });

  it("still builds when skip is requested but no dist exists to serve", () => {
    expect(
      resolveRendererBuildAction({
        forceRenderer: false,
        distStale: true,
        distExists: false,
        skipRequested: true,
      }),
    ).toBe("build");
  });

  it("lets force override an explicit skip", () => {
    expect(
      resolveRendererBuildAction({
        forceRenderer: true,
        distStale: true,
        distExists: true,
        skipRequested: true,
      }),
    ).toBe("build");
  });
});
