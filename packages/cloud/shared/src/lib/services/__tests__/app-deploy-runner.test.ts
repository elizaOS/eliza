// Exercises app deploy runner behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
import type { AppDeployRunnerDeps } from "../app-deploy-runner";
import { containerNameForApp, resolveImageRef } from "../app-deploy-runner";

// #13097 — the apps-deploy digest-pin gate is ON by default. Tests that exercise
// ONLY the allowlist / repo / org-namespace concerns (not the digest concern)
// opt the gate off so a mutable-tag fixture doesn't trip the digest gate first.
// Tests that exercise the digest concern use digest-pinned fixtures or arm the
// gate explicitly.
const DIGEST_GATE_OFF = { APPS_DEPLOY_REQUIRE_DIGEST: "false" };

// A first-party digest-pinned ref (passes both the allowlist and digest gates).
const PINNED = `ghcr.io/elizaos/eliza@sha256:a${"0".repeat(63)}`;

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
    const img = await runWithCloudBindingsAsync(DIGEST_GATE_OFF, () =>
      resolveImageRef(buildOff, {
        ...baseApp,
        repoUrl: REPO,
        // Allowlisted first-party namespace (the image allowlist gate runs on the
        // resolved image — see the gate describe block below).
        metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
      }),
    );
    expect(img).toBe("ghcr.io/elizaos/myapp:v1");
  });

  test("repo app + build on -> uses the built image", async () => {
    const buildOn = {
      resolveImage: async () => PINNED,
    } as unknown as AppDeployRunnerDeps;
    const img = await resolveImageRef(buildOn, { ...baseApp, repoUrl: REPO });
    expect(img).toBe(PINNED);
  });

  test("non-repo app still falls back to APP_DEFAULT_IMAGE (unchanged)", async () => {
    process.env.APP_DEFAULT_IMAGE = PINNED;
    expect(await resolveImageRef(buildOff, baseApp)).toBe(PINNED);
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
    delete process.env.APPS_DEPLOY_IMAGE_ALLOWLIST;
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
    const img = await runWithCloudBindingsAsync(DIGEST_GATE_OFF, () =>
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
      }),
    );
    expect(img).toBe("ghcr.io/elizaos/myapp:v1");
  });

  test("the default agent image passes the default allowlist", async () => {
    process.env.APP_DEFAULT_IMAGE = PINNED;
    expect(await resolveImageRef(buildOff, baseApp)).toBe(PINNED);
  });

  test("a mis-set APP_DEFAULT_IMAGE outside the allowlist is rejected", async () => {
    process.env.APP_DEFAULT_IMAGE = "docker.io/library/nginx:latest";
    await expect(resolveImageRef(buildOff, baseApp)).rejects.toThrow(/is not permitted/);
  });

  test("honors an operator-narrowed allowlist (rejects an off-list image)", async () => {
    process.env.APPS_DEPLOY_IMAGE_ALLOWLIST = "ghcr.io/onlyme/*";
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/elizaos/eliza:stable" },
      }),
    ).rejects.toThrow(/is not permitted/);
    const img = await runWithCloudBindingsAsync(DIGEST_GATE_OFF, () =>
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/onlyme/app:v1" },
      }),
    );
    expect(img).toBe("ghcr.io/onlyme/app:v1");
  });
});

// De-personalized apps-deploy allowlist (owner directive: "no personal shit").
// apps-deploy has its OWN allowlist (APPS_DEPLOY_IMAGE_ALLOWLIST) defaulting to
// `ghcr.io/elizaos/*` ONLY — the personal `ghcr.io/dexploarer/*` and the
// side-product `ghcr.io/waifufun/*` namespaces that the shared coding-container
// allowlist still carries are REJECTED for apps-deploy unless an operator opts
// them back in via the env. (The shared codingContainerImageAllowlist() default
// is intentionally left unchanged for the coding-container path.)
describe("resolveImageRef: apps-deploy allowlist is elizaos-only", () => {
  const baseApp = { id: "app-1", name: "demo", metadata: {} as Record<string, unknown> };
  const buildOff = { resolveImage: undefined } as unknown as AppDeployRunnerDeps;

  afterEach(() => {
    delete process.env.APPS_DEPLOY_IMAGE_ALLOWLIST;
    delete process.env.CODING_CONTAINER_IMAGE_ALLOWLIST;
  });

  test("allows a first-party ghcr.io/elizaos/* image by default", async () => {
    const img = await resolveImageRef(buildOff, {
      ...baseApp,
      metadata: { imageTag: PINNED },
    });
    expect(img).toBe(PINNED);
  });

  test("REJECTS ghcr.io/dexploarer/* by default (personal org)", async () => {
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/dexploarer/bnancy:latest" },
      }),
    ).rejects.toThrow(/is not permitted/);
  });

  test("REJECTS ghcr.io/waifufun/* by default (side product)", async () => {
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/waifufun/imagegen:latest" },
      }),
    ).rejects.toThrow(/is not permitted/);
  });

  test("does NOT read CODING_CONTAINER_IMAGE_ALLOWLIST (separate gate)", async () => {
    // Widening the CODING allowlist must NOT widen apps-deploy: a dexploarer
    // image stays rejected for apps-deploy even though the coding gate allows it.
    process.env.CODING_CONTAINER_IMAGE_ALLOWLIST = "ghcr.io/dexploarer/*";
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/dexploarer/bnancy:latest" },
      }),
    ).rejects.toThrow(/is not permitted/);
  });

  test("opt-in via APPS_DEPLOY_IMAGE_ALLOWLIST re-allows dexploarer + waifufun", async () => {
    process.env.APPS_DEPLOY_IMAGE_ALLOWLIST =
      "ghcr.io/elizaos/*,ghcr.io/dexploarer/*,ghcr.io/waifufun/*";
    const depPinned = `ghcr.io/dexploarer/bnancy@sha256:b${"0".repeat(63)}`;
    const waiPinned = `ghcr.io/waifufun/imagegen@sha256:c${"0".repeat(63)}`;
    expect(
      await runWithCloudBindingsAsync(DIGEST_GATE_OFF, () =>
        resolveImageRef(buildOff, {
          ...baseApp,
          metadata: { imageTag: depPinned },
        }),
      ),
    ).toBe(depPinned);
    expect(
      await runWithCloudBindingsAsync(DIGEST_GATE_OFF, () =>
        resolveImageRef(buildOff, {
          ...baseApp,
          metadata: { imageTag: waiPinned },
        }),
      ),
    ).toBe(waiPinned);
  });
});

// Per-org namespace extension — the normie app-deploy 403 fix (#8434 lane): a
// user's OWN registry namespace (ghcr.io/<their-login>/*) can be granted by an
// operator on the ORG record (settings.allowed_image_namespaces) instead of
// widening the platform-wide env allowlist for every tenant. Additive and
// fail-closed: consulted only after the env allowlist denies, only when the
// deploy carries an organizationId, and a failing lookup denies.
describe("resolveImageRef: per-org namespace extension", () => {
  const baseApp = { id: "app-1", name: "demo", metadata: {} as Record<string, unknown> };
  // A digest-pinned org image (passes the default-armed digest gate).
  const ORG_IMAGE = `ghcr.io/nubscarson/my-app@sha256:d${"0".repeat(63)}`;

  function depsWithOrgNamespaces(
    lookup: (orgId: string) => Promise<string[]>,
  ): AppDeployRunnerDeps {
    return {
      resolveImage: undefined,
      orgImageNamespaces: lookup,
    } as unknown as AppDeployRunnerDeps;
  }

  test("an operator-granted org namespace passes for THAT org", async () => {
    const seen: string[] = [];
    const deps = depsWithOrgNamespaces(async (orgId) => {
      seen.push(orgId);
      return ["ghcr.io/nubscarson/*"];
    });
    const img = await resolveImageRef(deps, {
      ...baseApp,
      organizationId: "org-1",
      metadata: { imageTag: ORG_IMAGE },
    });
    expect(img).toBe(ORG_IMAGE);
    expect(seen).toEqual(["org-1"]);
  });

  test("an org WITHOUT the grant still rejects the same image (no cross-tenant widening)", async () => {
    const deps = depsWithOrgNamespaces(async () => []);
    await expect(
      resolveImageRef(deps, {
        ...baseApp,
        organizationId: "org-2",
        metadata: { imageTag: ORG_IMAGE },
      }),
    ).rejects.toThrow(/is not permitted/);
  });

  test("the grant does not open OTHER namespaces for the granted org", async () => {
    const deps = depsWithOrgNamespaces(async () => ["ghcr.io/nubscarson/*"]);
    await expect(
      resolveImageRef(deps, {
        ...baseApp,
        organizationId: "org-1",
        metadata: { imageTag: "docker.io/evil/pwn:latest" },
      }),
    ).rejects.toThrow(/is not permitted/);
  });

  test("no organizationId → no lookup, still rejected (unchanged legacy path)", async () => {
    let called = false;
    const deps = depsWithOrgNamespaces(async () => {
      called = true;
      return ["ghcr.io/nubscarson/*"];
    });
    await expect(
      resolveImageRef(deps, { ...baseApp, metadata: { imageTag: ORG_IMAGE } }),
    ).rejects.toThrow(/is not permitted/);
    expect(called).toBe(false);
  });

  test("a throwing lookup fails closed with the lookup failure preserved", async () => {
    const deps = depsWithOrgNamespaces(async () => {
      throw new Error("db down");
    });
    await expect(
      resolveImageRef(deps, {
        ...baseApp,
        organizationId: "org-1",
        metadata: { imageTag: ORG_IMAGE },
      }),
    ).rejects.toMatchObject({
      message:
        "Failed to resolve app deploy image namespaces for organization org-1 while deploying app app-1",
      cause: expect.objectContaining({ message: "db down" }),
    });
  });

  test("an env-allowlisted image never consults the org lookup (fast path)", async () => {
    let called = false;
    const deps = depsWithOrgNamespaces(async () => {
      called = true;
      return [];
    });
    const img = await resolveImageRef(deps, {
      ...baseApp,
      organizationId: "org-1",
      metadata: { imageTag: PINNED },
    });
    expect(img).toBe(PINNED);
    expect(called).toBe(false);
  });
});

// #9853 follow-up — an app deploy is the THIRD shared-node image path (alongside
// the /v1/containers and /v1/coding-containers routes). When the digest-pin gate
// is armed, all three must reject a mutable `:tag`/`:latest` ref so the registry
// cannot swap the bytes behind an allowed name after the check.
//
// #13097 — the apps-deploy lane now enforces the digest-pin gate by DEFAULT via
// the lane-scoped `APPS_DEPLOY_REQUIRE_DIGEST` flag (ON unless an operator opts
// out with `APPS_DEPLOY_REQUIRE_DIGEST=false`). The global
// `CONTAINER_IMAGE_REQUIRE_DIGEST` gate is also inherited when armed.
describe("resolveImageRef: digest-pin gate (#13097, #9853 follow-up)", () => {
  const baseApp = { id: "app-1", name: "demo", metadata: {} as Record<string, unknown> };
  const buildOff = { resolveImage: undefined } as unknown as AppDeployRunnerDeps;

  test("DEFAULT (apps-deploy gate armed): a mutable :tag app image is rejected", async () => {
    await expect(
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
      }),
    ).rejects.toThrow(/must be pinned to a full sha256 digest/);
  });

  test("DEFAULT (apps-deploy gate armed): an implicit-latest (untagged) app image is rejected", async () => {
    await expect(
      resolveImageRef(buildOff, { ...baseApp, metadata: { imageTag: "ghcr.io/elizaos/myapp" } }),
    ).rejects.toThrow(/must be pinned to a full sha256 digest/);
  });

  test("DEFAULT (apps-deploy gate armed): a digest-pinned app image passes", async () => {
    const img = await resolveImageRef(buildOff, { ...baseApp, metadata: { imageTag: PINNED } });
    expect(img).toBe(PINNED);
  });

  test("APPS_DEPLOY_REQUIRE_DIGEST=false opts out (mutable :tag passes)", async () => {
    const img = await runWithCloudBindingsAsync(DIGEST_GATE_OFF, () =>
      resolveImageRef(buildOff, {
        ...baseApp,
        metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
      }),
    );
    expect(img).toBe("ghcr.io/elizaos/myapp:v1");
  });

  test("global CONTAINER_IMAGE_REQUIRE_DIGEST=true arms the gate even when the apps-deploy flag is off", async () => {
    await runWithCloudBindingsAsync(
      { CONTAINER_IMAGE_REQUIRE_DIGEST: "true", APPS_DEPLOY_REQUIRE_DIGEST: "false" },
      async () => {
        await expect(
          resolveImageRef(buildOff, {
            ...baseApp,
            metadata: { imageTag: "ghcr.io/elizaos/myapp:v1" },
          }),
        ).rejects.toThrow(/must be pinned to a full sha256 digest/);
      },
    );
  });

  test("global flag ON: a digest-pinned app image passes", async () => {
    await runWithCloudBindingsAsync({ CONTAINER_IMAGE_REQUIRE_DIGEST: "true" }, async () => {
      const img = await resolveImageRef(buildOff, { ...baseApp, metadata: { imageTag: PINNED } });
      expect(img).toBe(PINNED);
    });
  });
});
