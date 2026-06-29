import { afterEach, describe, expect, test } from "bun:test";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
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
      // Allowlisted first-party namespace (the image allowlist gate runs on the
      // resolved image — see the gate describe block below).
      metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
    });
    expect(img).toBe("ghcr.io/elizaos/myapp:v1");
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

// #9853 — an app deploy runs an image on our shared docker nodes, so the resolved
// image is gated on the same allowlist the coding-container routes use. Empty
// allowlist is fail-closed; the default allowlist covers the first-party GHCR
// namespaces (so the default agent image / APP_DEFAULT_IMAGE pass unchanged).
describe("resolveImageRef: image allowlist gate", () => {
  const baseApp = { id: "app-1", name: "demo", metadata: {} as Record<string, unknown> };
  const buildOff = { resolveImage: undefined } as unknown as AppDeployRunnerDeps;

  afterEach(() => {
    delete process.env.APP_DEFAULT_IMAGE;
    delete process.env.CODING_CONTAINER_IMAGE_ALLOWLIST;
  });

  test("rejects an imageTag outside the default allowlist", async () => {
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "docker.io/evil/pwn:latest" },
      }),
    ).rejects.toThrow(/is not permitted/);
  });

  test("allows an imageTag inside the default first-party allowlist", async () => {
    const img = await resolveImageRef(buildOff, {
      ...baseApp,
      metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
    });
    expect(img).toBe("ghcr.io/elizaos/myapp:v1");
  });

  test("the default agent image passes the default allowlist", async () => {
    process.env.APP_DEFAULT_IMAGE = "ghcr.io/elizaos/eliza:stable";
    expect(await resolveImageRef(buildOff, baseApp)).toBe("ghcr.io/elizaos/eliza:stable");
  });

  test("a mis-set APP_DEFAULT_IMAGE outside the allowlist is rejected", async () => {
    process.env.APP_DEFAULT_IMAGE = "docker.io/library/nginx:latest";
    await expect(resolveImageRef(buildOff, baseApp)).rejects.toThrow(/is not permitted/);
  });

  test("honors an operator-narrowed allowlist (rejects an off-list image)", async () => {
    process.env.CODING_CONTAINER_IMAGE_ALLOWLIST = "ghcr.io/onlyme/*";
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/elizaos/eliza:stable" },
      }),
    ).rejects.toThrow(/is not permitted/);
    const img = await resolveImageRef(buildOff, {
      ...baseApp,
      metadata: { imageTag: "ghcr.io/onlyme/app:v1" },
    });
    expect(img).toBe("ghcr.io/onlyme/app:v1");
  });
});

// #9853 follow-up — an app deploy is the THIRD shared-node image path (alongside
// the /v1/containers and /v1/coding-containers routes). When the opt-in
// digest-pin gate (CONTAINER_IMAGE_REQUIRE_DIGEST) is armed, all three must
// reject a mutable `:tag`/`:latest` ref so the registry cannot swap the bytes
// behind an allowed name after the check; previously this path skipped the gate.
describe("resolveImageRef: digest-pin gate (#9853 follow-up)", () => {
  const baseApp = { id: "app-1", name: "demo", metadata: {} as Record<string, unknown> };
  const buildOff = { resolveImage: undefined } as unknown as AppDeployRunnerDeps;
  // An allowlisted first-party digest-pinned ref (passes both gates).
  const PINNED = `ghcr.io/elizaos/eliza@sha256:a${"0".repeat(63)}`;

  test("flag ON: a mutable :tag app image is rejected", async () => {
    await runWithCloudBindingsAsync({ CONTAINER_IMAGE_REQUIRE_DIGEST: "true" }, async () => {
      await expect(
        resolveImageRef(buildOff, {
          ...baseApp,
          metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
        }),
      ).rejects.toThrow(/must be pinned to a full sha256 digest/);
    });
  });

  test("flag ON: an implicit-latest (untagged) app image is rejected", async () => {
    await runWithCloudBindingsAsync({ CONTAINER_IMAGE_REQUIRE_DIGEST: "true" }, async () => {
      await expect(
        resolveImageRef(buildOff, { ...baseApp, metadata: { imageTag: "ghcr.io/elizaos/myapp" } }),
      ).rejects.toThrow(/must be pinned to a full sha256 digest/);
    });
  });

  test("flag ON: a digest-pinned app image passes", async () => {
    await runWithCloudBindingsAsync({ CONTAINER_IMAGE_REQUIRE_DIGEST: "true" }, async () => {
      const img = await resolveImageRef(buildOff, { ...baseApp, metadata: { imageTag: PINNED } });
      expect(img).toBe(PINNED);
    });
  });

  test("flag OFF (default): a mutable :tag app image is unchanged (passes)", async () => {
    const img = await resolveImageRef(buildOff, {
      ...baseApp,
      metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
    });
    expect(img).toBe("ghcr.io/elizaos/myapp:v1");
  });
});
