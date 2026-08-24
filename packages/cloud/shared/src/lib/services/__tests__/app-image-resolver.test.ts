// Exercises app image resolver behavior with deterministic cloud-shared lib fixtures.
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
      return "built";
    },
  };
  return { builder: new AppImageBuilder({ exec, isolatedBuilder: false }), cmds };
}

describe("makeBuildFromRepoResolver", () => {
  test("builds + pushes from app.github_repo and returns the ref", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "ghcr.io/elizaos" });
    const ref = await resolve({
      id: APP,
      name: "demo",
      metadata: { ref: "a1b2c3d" },
      repoUrl: "https://github.com/u/repo.git",
    });

    expect(ref).toBe("ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d");
    expect(cmds[0]).toContain("docker buildx build");
    expect(cmds[0]).toContain("--push");
    expect(cmds[0]).toContain("'https://github.com/u/repo.git#a1b2c3d'");
  });

  test("falls back to metadata.repoUrl when github_repo is absent", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });
    await expect(
      resolve({ id: APP, name: "demo", metadata: { repoUrl: "/local/ctx" } }),
    ).rejects.toThrow();
    expect(cmds).toHaveLength(0);
  });

  test("rejects SSRF and redirect targets at the BuildKit sink without executing", async () => {
    for (const repoUrl of [
      "https://user:secret@github.com/u/repo.git",
      "http://github.com/u/repo.git",
      "https://localhost/u/repo.git",
      "https://127.0.0.1/u/repo.git",
      "https://[::1]/u/repo.git",
      "https://10.0.0.1/u/repo.git",
      "https://169.254.169.254/latest/meta-data.git",
      "https://2130706433/u/repo.git",
      "https://rebind.network/u/repo.git",
      "https://httpbin.org/redirect-to?url=https://github.com/u/repo.git",
      "https://github.com.evil.test/u/repo.git",
      "https://gith\u0443b.com/u/repo.git",
      "https://github.com/%2e%2e/repo.git",
    ]) {
      const { builder, cmds } = recordingBuilder();
      const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });

      await expect(resolve({ id: APP, name: "demo", metadata: { repoUrl } })).rejects.toThrow();
      expect(cmds).toHaveLength(0);
    }
  });

  test("canonicalizes persisted owner/repo shorthand before BuildKit", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });

    await resolve({ id: APP, name: "demo", metadata: {}, repoUrl: "elizaOS/eliza" });

    expect(cmds[0]).toContain("'https://github.com/elizaOS/eliza.git'");
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

    expect(ref).toBe("r/app-aaaaaaaaaaaa4aaa8aaaaaaa:develop");
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

  test("ignores invalid JSON maps", () => {
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "not-json" })).toBeUndefined();
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
