// Exercises app image builder behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  AppImageBuilder,
  buildImagetoolsInspectCmd,
  type BuildExec,
  parseImagetoolsDigest,
} from "../app-image-builder";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF = "ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d";
const DIGEST = "sha256:2c68b639eec00fad1b35e978f5463f1543b392c96680ec496fd0c0a9eddc8241";
const PINNED_REF = `${REF}@${DIGEST}`;

function fakeExec(): BuildExec & { calls: Array<{ cmd: string; timeoutMs?: number }> } {
  const calls: Array<{ cmd: string; timeoutMs?: number }> = [];
  return {
    calls,
    async exec(cmd: string, timeoutMs?: number) {
      calls.push({ cmd, timeoutMs });
      // When the builder inspects the pushed image, return a manifest digest so
      // the builder can pin the returned ref. Otherwise return build output.
      if (cmd.startsWith("docker buildx imagetools inspect")) {
        return `Name:      ${REF}\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    ${DIGEST}\n`;
      }
      return "Successfully built abc123";
    },
  };
}

describe("parseImagetoolsDigest", () => {
  test("extracts the first sha256:<64hex> digest", () => {
    expect(
      parseImagetoolsDigest(
        `Name:      ${REF}\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    sha256:abc123def4567890abc123def4567890abc123def4567890abc123def4567890\n`,
      ),
    ).toBe("sha256:abc123def4567890abc123def4567890abc123def4567890abc123def4567890");
  });

  test("returns null when no digest is present", () => {
    expect(parseImagetoolsDigest("no digest here")).toBeNull();
  });

  test("ignores partial digests (<64 hex)", () => {
    expect(parseImagetoolsDigest("sha256:abc123")).toBeNull();
  });
});

describe("buildImagetoolsInspectCmd", () => {
  test("assembles the imagetools inspect command with a quoted ref", () => {
    expect(buildImagetoolsInspectCmd(REF)).toBe(`docker buildx imagetools inspect '${REF}'`);
  });
});

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

    // No push → mutable ref (local --load build, no registry manifest to pin).
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
    const buildCmd = exec.calls[0].cmd;
    expect(buildCmd).toContain("docker buildx build --builder 'apps-build-");
    expect(buildCmd).toContain("--push");
    expect(buildCmd).not.toContain("--load");
    expect(buildCmd).toContain("docker buildx create --driver docker-container");
  });

  test("push resolves the immutable digest and returns a digest-pinned ref (#13097)", async () => {
    const exec = fakeExec();
    const res = await new AppImageBuilder({ exec }).build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      sourceRef: "a1b2c3d",
      context: "https://github.com/u/repo.git#main",
      push: true,
    });
    // The pushed ref is pinned to the resolved manifest digest.
    expect(res.imageRef).toBe(PINNED_REF);
    // Two exec calls: the build, then the imagetools inspect.
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[1].cmd).toBe(`docker buildx imagetools inspect '${REF}'`);
  });

  test("push falls back to the mutable ref when inspect returns no digest", async () => {
    const latestRef = "ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:latest";
    const exec: BuildExec & { calls: Array<{ cmd: string }> } = {
      calls: [],
      async exec(cmd: string) {
        this.calls.push({ cmd });
        if (cmd.startsWith("docker buildx imagetools inspect")) {
          return "no digest available";
        }
        return "built";
      },
    };
    const res = await new AppImageBuilder({ exec }).build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      context: "/c",
      push: true,
    });
    // Inspect ran but found no digest → fall back to the mutable ref (non-fatal).
    expect(res.imageRef).toBe(latestRef);
  });

  test("push falls back to the mutable ref when inspect throws (registry lag)", async () => {
    const latestRef = "ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:latest";
    const exec: BuildExec & { calls: Array<{ cmd: string }> } = {
      calls: [],
      async exec(cmd: string) {
        this.calls.push({ cmd });
        if (cmd.startsWith("docker buildx imagetools inspect")) {
          throw new Error("registry timeout");
        }
        return "built";
      },
    };
    const res = await new AppImageBuilder({ exec }).build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      context: "/c",
      push: true,
    });
    expect(res.imageRef).toBe(latestRef);
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
