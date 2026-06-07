import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec } from "../app-image-builder";
import { makeBuildFromRepoResolver } from "../app-image-resolver";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    expect(cmds[0]).toContain("'https://github.com/u/repo.git'");
  });

  test("falls back to metadata.repoUrl when github_repo is absent", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });
    const ref = await resolve({ id: APP, name: "demo", metadata: { repoUrl: "/local/ctx" } });
    expect(ref).toBe("r/app-aaaaaaaaaaaa4aaa8aaaaaaa:latest");
    expect(cmds[0]).toContain("'/local/ctx'");
  });

  test("returns undefined (no error) when the app has no repo", async () => {
    const { builder, cmds } = recordingBuilder();
    const resolve = makeBuildFromRepoResolver({ builder, registry: "r" });
    expect(await resolve({ id: APP, name: "demo", metadata: {} })).toBeUndefined();
    expect(cmds).toHaveLength(0);
  });
});
