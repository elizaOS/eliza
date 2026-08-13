/** Exercises app image resolver behavior with deterministic cloud-shared lib fixtures. */
import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec } from "../app-image-builder";
import {
  composeImageResolvers,
  makeBuildFromRepoResolver,
  makePrebuiltImageMapResolver,
} from "../app-image-resolver";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function recordingBuilder(): { builder: AppImageBuilder; cmds: string[] } {
  const cmds: string[] = [];
  const exec: BuildExec = {
    async exec(cmd) {
      cmds.push(cmd);
      // BuildKit records the exact pushed manifest digest in per-build metadata.
      const marker = cmd.match(/ELIZA_APP_BUILD_METADATA_[0-9a-f]{24}/)?.[0];
      return marker
        ? `built\n${marker}\n${JSON.stringify({
            "containerimage.digest":
              "sha256:abc123def4567890abc123def4567890abc123def4567890abc123def4567890",
          })}`
        : "built";
    },
  };
  return { builder: new AppImageBuilder({ exec, isolatedBuilder: false }), cmds };
}

describe("makeBuildFromRepoResolver", () => {
  // The builder pushes and resolves the manifest digest (#13097), so push builds
  // return a digest-pinned ref: `<mutable-ref>@sha256:<64hex>`.
  const DIGEST = "sha256:abc123def4567890abc123def4567890abc123def4567890abc123def4567890";

  test("builds + pushes from app.github_repo and returns the digest-pinned ref", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "ghcr.io/elizaos" });
    const ref = await resolve({
      id: APP,
      name: "demo",
      metadata: { ref: "a1b2c3d" },
      repoUrl: "https://github.com/u/repo.git",
    });

    expect(ref).toBe(`ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d@${DIGEST}`);
    expect(cmds[0]).toContain("docker buildx build");
    expect(cmds[0]).toContain("--push");
    expect(cmds[0]).toContain("'https://github.com/u/repo.git#a1b2c3d'");
  });

  test("falls back to metadata.repoUrl when github_repo is absent", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });
    const ref = await resolve({ id: APP, name: "demo", metadata: { repoUrl: "/local/ctx" } });
    expect(ref).toBe(`r/app-aaaaaaaaaaaa4aaa8aaaaaaa:latest@${DIGEST}`);
    expect(cmds[0]).toContain("'/local/ctx'");
  });

  test("uses deploy metadata for repo, ref, and Dockerfile", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({
      builder,
      registry: "r",
      dockerfile: "Dockerfile",
    });
    const ref = await resolve({
      id: APP,
      name: "demo",
      metadata: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
        dockerfile: "apps/example/Dockerfile.cloud",
      },
      repoUrl: "https://github.com/linked/repo.git",
    });

    expect(ref).toBe(`r/app-aaaaaaaaaaaa4aaa8aaaaaaa:develop@${DIGEST}`);
    expect(cmds[0]).toContain("--file 'apps/example/Dockerfile.cloud'");
    expect(cmds[0]).toContain("'https://github.com/elizaOS/eliza.git#develop'");
    expect(cmds[0]).not.toContain("https://github.com/linked/repo.git");
  });

  test("returns undefined (no error) when the app has no repo", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });
    expect(await resolve({ id: APP, name: "demo", metadata: {} })).toBeUndefined();
    expect(cmds).toHaveLength(0);
  });
});

describe("makePrebuiltImageMapResolver", () => {
  test("returns undefined when no map is configured", () => {
    expect(makePrebuiltImageMapResolver({})).toBeUndefined();
  });

  test("uses the longest matching app name prefix", async () => {
    const resolve = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: JSON.stringify({
        "Clone Your Crush": "ghcr.io/elizaos/clone:base",
        "Clone Your Crush Showcase": "ghcr.io/elizaos/clone:showcase",
        "eDad Showcase": "ghcr.io/elizaos/edad:showcase",
      }),
    });

    expect(resolve).toBeDefined();
    await expect(
      resolve?.({
        id: APP,
        name: "Clone Your Crush Showcase 8f3a",
        metadata: {},
      }),
    ).resolves.toBe("ghcr.io/elizaos/clone:showcase");
    await expect(
      resolve?.({
        id: APP,
        name: "eDad Showcase 1a2b",
        metadata: {},
      }),
    ).resolves.toBe("ghcr.io/elizaos/edad:showcase");
    await expect(resolve?.({ id: APP, name: "Other App", metadata: {} })).resolves.toBeUndefined();
  });

  test("rejects invalid JSON maps", () => {
    expect(() => makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "not-json" })).toThrow(
      /must be valid JSON/,
    );
  });
});

describe("composeImageResolvers", () => {
  test("returns undefined when no resolver is active", () => {
    expect(composeImageResolvers(undefined)).toBeUndefined();
  });

  test("returns the first resolver image and falls through undefined results", async () => {
    const resolve = composeImageResolvers(
      () => undefined,
      () => "ghcr.io/elizaos/app:prebuilt",
      () => "ghcr.io/elizaos/app:later",
    );

    expect(resolve).toBeDefined();
    await expect(resolve?.({ id: APP, name: "demo", metadata: {} })).resolves.toBe(
      "ghcr.io/elizaos/app:prebuilt",
    );
  });
});
