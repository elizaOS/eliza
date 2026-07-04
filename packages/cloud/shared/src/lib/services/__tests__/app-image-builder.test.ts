// Exercises app image builder behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec } from "../app-image-builder";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF = "ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d";

function fakeExec(): BuildExec & { calls: Array<{ cmd: string; timeoutMs?: number }> } {
  const calls: Array<{ cmd: string; timeoutMs?: number }> = [];
  return {
    calls,
    async exec(cmd: string, timeoutMs?: number) {
      calls.push({ cmd, timeoutMs });
      return "Successfully built abc123";
    },
  };
}

describe("AppImageBuilder", () => {
  test("resolves the ref and execs the build inside a THROWAWAY isolated builder by default", async () => {
    const exec = fakeExec();
    const builder = new AppImageBuilder({ exec });
    const res = await builder.build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      sourceRef: "a1b2c3d",
      context: "/work/repo",
      dockerfile: "Dockerfile",
    });

    expect(res.imageRef).toBe(REF);
    expect(res.buildOutput).toContain("Successfully built");
    expect(exec.calls).toHaveLength(1);

    const cmd = exec.calls[0].cmd;
    // Untrusted Dockerfile → fresh isolated docker-container BuildKit, torn down.
    expect(cmd).toContain("docker buildx create --driver docker-container --name 'apps-build-");
    expect(cmd).toContain("--bootstrap");
    expect(cmd).toContain("trap 'docker buildx rm --force 'apps-build-");
    expect(cmd).toMatch(/EXIT/);
    // The build pins --builder to that throwaway instance, never the host default.
    expect(cmd).toContain(`docker buildx build --builder 'apps-build-`);
    expect(cmd).toContain(`--tag '${REF}'`);
    expect(cmd).toContain("--file 'Dockerfile'");
    expect(cmd).toContain("'/work/repo'");
    expect(cmd).toContain("set -e");
  });

  test("uses a unique throwaway builder name per build (no shared BuildKit)", async () => {
    const exec = fakeExec();
    const builder = new AppImageBuilder({ exec });
    const req = { registry: "ghcr.io/elizaos", appId: APP, context: "/c" } as const;
    await builder.build(req);
    await builder.build(req);
    const name = (cmd: string) => cmd.match(/--name '(apps-build-[^']+)'/)?.[1];
    const a = name(exec.calls[0].cmd);
    const b = name(exec.calls[1].cmd);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  test("push runs --push from inside the isolated builder (never loads into host daemon)", async () => {
    const exec = fakeExec();
    await new AppImageBuilder({ exec }).build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      context: "https://github.com/u/repo.git#main",
      push: true,
    });
    const cmd = exec.calls[0].cmd;
    expect(cmd).toContain("docker buildx build --builder 'apps-build-");
    expect(cmd).toContain("--push");
    expect(cmd).not.toContain("--load");
    expect(cmd).toContain("docker buildx create --driver docker-container");
  });

  test("isolatedBuilder:false runs the plain host-daemon build (trusted/verification only)", async () => {
    const exec = fakeExec();
    const builder = new AppImageBuilder({ exec, isolatedBuilder: false });
    await builder.build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      sourceRef: "a1b2c3d",
      context: "/work/repo",
      dockerfile: "Dockerfile",
    });
    expect(exec.calls[0].cmd).toBe(`docker build --tag '${REF}' --file 'Dockerfile' '/work/repo'`);
    expect(exec.calls[0].cmd).not.toContain("buildx create");
  });

  test("propagates a build failure", async () => {
    const exec: BuildExec = {
      async exec() {
        throw new Error("exit 1: dockerfile parse error");
      },
    };
    await expect(
      new AppImageBuilder({ exec }).build({ registry: "r", appId: APP, context: "/c" }),
    ).rejects.toThrow(/parse error/);
  });
});
