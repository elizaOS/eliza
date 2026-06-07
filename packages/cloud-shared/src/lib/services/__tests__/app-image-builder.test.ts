import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec } from "../app-image-builder";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  test("resolves the ref and execs the composed build command", async () => {
    const exec = fakeExec();
    const builder = new AppImageBuilder({ exec });
    const res = await builder.build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      sourceRef: "a1b2c3d",
      context: "/work/repo",
      dockerfile: "Dockerfile",
    });

    expect(res.imageRef).toBe("ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d");
    expect(res.buildOutput).toContain("Successfully built");
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].cmd).toBe(
      "docker build --tag 'ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d' --file 'Dockerfile' '/work/repo'",
    );
  });

  test("push routes through buildx --push", async () => {
    const exec = fakeExec();
    await new AppImageBuilder({ exec }).build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      context: "https://github.com/u/repo.git#main",
      push: true,
    });
    expect(exec.calls[0].cmd.startsWith("docker buildx build")).toBe(true);
    expect(exec.calls[0].cmd).toContain("--push");
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
