// Exercises app image resolver behavior with deterministic cloud-shared lib
// fixtures. Verifies the #13097 contract: pushed builds return digest-pinned
// refs (not mutable tags) captured atomically from the build invocation.
import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec, type MetadataReader } from "../app-image-builder";
import {
  composeImageResolvers,
  makeBuildFromRepoResolver,
  makePrebuiltImageMapResolver,
} from "../app-image-resolver";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DIGEST = "sha256:a1b32e421ac1a7a3b3e1485fa34ceced6dec756893baf8bc9022298c3f6d0f88";

function recordingBuilder(): { builder: AppImageBuilder; cmds: string[] } {
  const cmds: string[] = [];
  const exec: BuildExec = {
    async exec(cmd) {
      cmds.push(cmd);
      return "built";
    },
  };
  const reader: MetadataReader = {
    async read() {
      return JSON.stringify({ "containerimage.digest": DIGEST });
    },
  };
  return {
    builder: new AppImageBuilder({ exec, metadataReader: reader, isolatedBuilder: false }),
    cmds,
  };
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

    expect(ref).toBe(`ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa@${DIGEST}`);
    expect(cmds[0]).toContain("docker buildx build");
    expect(cmds[0]).toContain("--push");
    expect(cmds[0]).toContain("'https://github.com/u/repo.git#a1b2c3d'");
  });

  test("falls back to metadata.repoUrl when github_repo is absent", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });
    const ref = await resolve({ id: APP, name: "demo", metadata: { repoUrl: "/local/ctx" } });
    expect(ref).toBe(`r/app-aaaaaaaaaaaa4aaa8aaaaaaa@${DIGEST}`);
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

    expect(ref).toBe(`r/app-aaaaaaaaaaaa4aaa8aaaaaaa@${DIGEST}`);
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

  test("pins first-party showcase mutable tags to digest refs (#13097)", async () => {
    const resolve = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: JSON.stringify({
        "eDad Showcase": "ghcr.io/elizaos/example-edad:showcase",
        "Clone Your Crush Showcase": "ghcr.io/elizaos/example-clone-ur-crush:showcase",
      }),
    });

    expect(resolve).toBeDefined();
    await expect(resolve?.({ id: APP, name: "eDad Showcase 1a2b", metadata: {} })).resolves.toBe(
      "ghcr.io/elizaos/example-edad@sha256:a1b32e421ac1a7a3b3e1485fa34ceced6dec756893baf8bc9022298c3f6d0f88",
    );
    await expect(
      resolve?.({ id: APP, name: "Clone Your Crush Showcase 8f3a", metadata: {} }),
    ).resolves.toBe(
      "ghcr.io/elizaos/example-clone-ur-crush@sha256:0c69b045f44e799f4415d346450713c49129793c45caccb8512deeee5d6701f7",
    );
  });

  test("passes through non-first-party refs unchanged", async () => {
    const resolve = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: JSON.stringify({
        "Custom App": "ghcr.io/custom/app:v1",
      }),
    });

    expect(resolve).toBeDefined();
    await expect(resolve?.({ id: APP, name: "Custom App 1", metadata: {} })).resolves.toBe(
      "ghcr.io/custom/app:v1",
    );
  });

  test("passes through already-digest-pinned refs unchanged", async () => {
    const pinned = "ghcr.io/elizaos/app@sha256:" + "a".repeat(64);
    const resolve = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: JSON.stringify({ "Pinned App": pinned }),
    });

    expect(resolve).toBeDefined();
    await expect(resolve?.({ id: APP, name: "Pinned App 1", metadata: {} })).resolves.toBe(pinned);
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
