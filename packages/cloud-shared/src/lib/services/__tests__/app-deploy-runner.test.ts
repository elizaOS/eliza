import { afterEach, describe, expect, test } from "bun:test";
import type { AppDeployRunnerDeps } from "../app-deploy-runner";
import { containerNameForApp, resolveImageRef } from "../app-deploy-runner";

// #9145 — container names must be stable + DNS/Docker-safe regardless of app id.
describe("containerNameForApp (#9145)", () => {
  test("produces a lowercase app-<slug> name", () => {
    expect(containerNameForApp("MyApp")).toBe("app-myapp");
  });

  test("strips every non-alphanumeric character", () => {
    expect(containerNameForApp("a1b2-C3.D4_e5")).toBe("app-a1b2c3d4e5");
  });

  test("truncates the slug to 12 chars (16 total)", () => {
    const name = containerNameForApp("abcdefghijklmnopqrstuvwxyz");
    expect(name).toBe("app-abcdefghijkl");
    expect(name.length).toBe(16);
  });

  test("is deterministic for a UUID id", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(containerNameForApp(id)).toBe("app-550e8400e29b");
    expect(containerNameForApp(id)).toBe(containerNameForApp(id));
  });
});

// build-from-repo is intentionally deferred (prebuilt-image only). A repo-configured
// app must NOT silently deploy APP_DEFAULT_IMAGE in place of the user's code when the
// build resolver is off — that would be a silent wrong deploy.
describe("resolveImageRef: build-from-repo-disabled guard", () => {
  const baseApp = { id: "app-1", name: "demo", metadata: {} as Record<string, unknown> };
  const buildOff = { resolveImage: undefined } as unknown as AppDeployRunnerDeps;
  const REPO = "https://github.com/u/repo.git";

  afterEach(() => {
    delete process.env.APP_DEFAULT_IMAGE;
  });

  test("repo app + build off + no imageTag -> throws, does NOT fall back to APP_DEFAULT_IMAGE", async () => {
    process.env.APP_DEFAULT_IMAGE = "ghcr.io/elizaos/app-default:smoke";
    await expect(resolveImageRef(buildOff, { ...baseApp, repoUrl: REPO })).rejects.toThrow(
      /build-from-repo is disabled/,
    );
  });

  test("repo app + build off + explicit imageTag -> uses the prebuilt image", async () => {
    process.env.APP_DEFAULT_IMAGE = "ghcr.io/elizaos/app-default:smoke";
    const img = await resolveImageRef(buildOff, {
      ...baseApp,
      repoUrl: REPO,
      metadata: { imageTag: "ghcr.io/u/myapp:v1" },
    });
    expect(img).toBe("ghcr.io/u/myapp:v1");
  });

  test("repo app + build on -> uses the built image", async () => {
    const buildOn = {
      resolveImage: async () => "ghcr.io/elizaos/app-built:abc",
    } as unknown as AppDeployRunnerDeps;
    const img = await resolveImageRef(buildOn, { ...baseApp, repoUrl: REPO });
    expect(img).toBe("ghcr.io/elizaos/app-built:abc");
  });

  test("non-repo app still falls back to APP_DEFAULT_IMAGE (unchanged)", async () => {
    process.env.APP_DEFAULT_IMAGE = "ghcr.io/elizaos/app-default:smoke";
    expect(await resolveImageRef(buildOff, baseApp)).toBe("ghcr.io/elizaos/app-default:smoke");
  });
});
