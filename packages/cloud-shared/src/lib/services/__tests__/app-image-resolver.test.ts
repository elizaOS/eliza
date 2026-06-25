import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec } from "../app-image-builder";
import {
  type AppImageResolver,
  composeImageResolvers,
  makeBuildFromRepoResolver,
  makePrebuiltImageMapResolver,
} from "../app-image-resolver";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EDAD_IMAGE = "ghcr.io/elizaos/example-edad:showcase";
const CUC_IMAGE = "ghcr.io/elizaos/example-clone-ur-crush:showcase";
const PREBUILT_MAP = JSON.stringify({
  "eDad Showcase": EDAD_IMAGE,
  "Clone Your Crush Showcase": CUC_IMAGE,
});

const app = (name: string) => ({ id: APP, name, metadata: {} as Record<string, unknown> });

function recordingBuilder(): { builder: AppImageBuilder; cmds: string[] } {
  const cmds: string[] = [];
  const exec: BuildExec = {
    async exec(cmd) {
      cmds.push(cmd);
      return "built";
    },
  };
  return { builder: new AppImageBuilder({ exec }), cmds };
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
    const ref = await resolve({ id: APP, name: "demo", metadata: { repoUrl: "/local/ctx" } });
    expect(ref).toBe("r/app-aaaaaaaaaaaa4aaa8aaaaaaa:latest");
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
        dockerfile: "packages/examples/cloud/edad/Dockerfile",
      },
      repoUrl: "https://github.com/linked/repo.git",
    });

    expect(ref).toBe("r/app-aaaaaaaaaaaa4aaa8aaaaaaa:develop");
    expect(cmds[0]).toContain("--file 'packages/examples/cloud/edad/Dockerfile'");
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
  test("returns undefined when APP_PREBUILT_IMAGES is unset or invalid", () => {
    expect(makePrebuiltImageMapResolver({})).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "" })).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "{not json" })).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "[]" })).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "{}" })).toBeUndefined();
  });

  test("maps repo-less showcase apps to prebuilt images by longest name prefix", async () => {
    const resolve = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: JSON.stringify({
        eDad: "ghcr.io/short:1",
        "eDad Showcase": EDAD_IMAGE,
        "Clone Your Crush Showcase": CUC_IMAGE,
      }),
    }) as AppImageResolver;

    expect(await resolve(app("eDad Showcase 1a2b3c"))).toBe(EDAD_IMAGE);
    expect(await resolve(app("Clone Your Crush Showcase 9z8y7x"))).toBe(CUC_IMAGE);
    expect(await resolve(app("eDad Lite 42"))).toBe("ghcr.io/short:1");
    expect(await resolve(app("Some Other App"))).toBeUndefined();
  });
});

describe("composeImageResolvers", () => {
  test("returns undefined when no resolvers are active", () => {
    expect(composeImageResolvers(undefined, undefined)).toBeUndefined();
  });

  test("uses the first resolver that returns an image", async () => {
    const build: AppImageResolver = async (candidate) =>
      candidate.name === "Built" ? "img-build" : undefined;
    const prebuilt = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: PREBUILT_MAP,
    }) as AppImageResolver;
    const composed = composeImageResolvers(build, prebuilt) as AppImageResolver;

    expect(await composed(app("Built"))).toBe("img-build");
    expect(await composed(app("eDad Showcase 42"))).toBe(EDAD_IMAGE);
    expect(await composed(app("Other"))).toBeUndefined();
  });
});
