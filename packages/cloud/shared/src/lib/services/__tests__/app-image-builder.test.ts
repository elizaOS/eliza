// Exercises app image builder behavior with deterministic cloud-shared lib
// fixtures. The builder is the impure build executor; its only IO is the
// injected `exec` seam and the optional `metadataReader` seam, so the full
// build+digest-capture flow is unit-testable with fakes. Verifies the #13097
// atomic-digest contract: when pushing, the returned ref is digest-pinned from
// the SAME build invocation's metadata file, never re-resolved by tag.
import { describe, expect, test } from "bun:test";
import { AppImageBuilder, type BuildExec, type MetadataReader } from "../app-image-builder";
import { BuildMetadataError } from "../build-metadata";

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF = "ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d";
const DIGEST = "sha256:a1b32e421ac1a7a3b3e1485fa34ceced6dec756893baf8bc9022298c3f6d0f88";
const PINNED_REF = `ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa@${DIGEST}`;

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

function fakeMetadataReader(content: string): MetadataReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(path: string) {
      calls.push(path);
      return content;
    },
  };
}

const METADATA_JSON = JSON.stringify({ "containerimage.digest": DIGEST });

describe("AppImageBuilder — atomic digest capture (#13097)", () => {
  test("a pushed build returns a digest-pinned ref from --metadata-file", async () => {
    const exec = fakeExec();
    const reader = fakeMetadataReader(METADATA_JSON);
    const builder = new AppImageBuilder({ exec, metadataReader: reader });
    const res = await builder.build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      sourceRef: "a1b2c3d",
      context: "/work/repo",
      push: true,
    });

    // The returned ref is content-addressed, not the mutable tag.
    expect(res.imageRef).toBe(PINNED_REF);
    expect(res.tagRef).toBe(REF);
    expect(res.digest).toBe(DIGEST);

    // The build command used --metadata-file to capture the digest atomically.
    const cmd = exec.calls[0].cmd;
    expect(cmd).toContain("--metadata-file ");
    expect(cmd).toContain("--push");

    // The reader was called to parse the metadata.
    expect(reader.calls).toHaveLength(1);
  });

  test("a non-pushed (local) build returns the mutable tag ref — no digest", async () => {
    const exec = fakeExec();
    const reader = fakeMetadataReader(METADATA_JSON);
    const builder = new AppImageBuilder({ exec, metadataReader: reader });
    const res = await builder.build({
      registry: "ghcr.io/elizaos",
      appId: APP,
      sourceRef: "a1b2c3d",
      context: "/work/repo",
      // push not set — local build only
    });

    expect(res.imageRef).toBe(REF);
    expect(res.digest).toBeUndefined();
    // No metadata-file for non-pushed builds.
    expect(exec.calls[0].cmd).not.toContain("--metadata-file");
    expect(reader.calls).toHaveLength(0);
  });

  test("throws BuildMetadataError when a pushed build has no metadata reader", async () => {
    const exec = fakeExec();
    const builder = new AppImageBuilder({ exec }); // no metadataReader
    await expect(
      builder.build({
        registry: "ghcr.io/elizaos",
        appId: APP,
        context: "/work/repo",
        push: true,
      }),
    ).rejects.toThrow(BuildMetadataError);
  });

  test("throws BuildMetadataError when the metadata file is missing (read fails)", async () => {
    const exec = fakeExec();
    const reader: MetadataReader = {
      async read() {
        throw new Error("ENOENT: no such file");
      },
    };
    const builder = new AppImageBuilder({ exec, metadataReader: reader });
    await expect(
      builder.build({
        registry: "ghcr.io/elizaos",
        appId: APP,
        context: "/work/repo",
        push: true,
      }),
    ).rejects.toThrow(BuildMetadataError);
  });

  test("throws BuildMetadataError when the metadata file has invalid JSON", async () => {
    const exec = fakeExec();
    const reader = fakeMetadataReader("not json at all");
    const builder = new AppImageBuilder({ exec, metadataReader: reader });
    await expect(
      builder.build({
        registry: "ghcr.io/elizaos",
        appId: APP,
        context: "/work/repo",
        push: true,
      }),
    ).rejects.toThrow(BuildMetadataError);
  });

  test("throws BuildMetadataError when the metadata file has no containerimage.digest", async () => {
    const exec = fakeExec();
    const reader = fakeMetadataReader(JSON.stringify({ other: "field" }));
    const builder = new AppImageBuilder({ exec, metadataReader: reader });
    await expect(
      builder.build({
        registry: "ghcr.io/elizaos",
        appId: APP,
        context: "/work/repo",
        push: true,
      }),
    ).rejects.toThrow(/missing or invalid/);
  });
});

describe("AppImageBuilder — build isolation (unchanged from prior behavior)", () => {
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
    const reader = fakeMetadataReader(METADATA_JSON);
    await new AppImageBuilder({ exec, metadataReader: reader }).build({
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
