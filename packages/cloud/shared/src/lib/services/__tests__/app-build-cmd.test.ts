// Exercises app build cmd behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  buildAppImageBuildCmd,
  buildAppImagePushCmd,
  buildIsolatedAppImageScript,
  isolatedBuilderName,
} from "../app-build-cmd";

const REF = "ghcr.io/elizaos/app-aaaaaaaaaaaa4aaa8aaaaaaa:a1b2c3d";

describe("buildAppImageBuildCmd", () => {
  test("plain docker build from a local context, no push", () => {
    expect(buildAppImageBuildCmd({ context: "/work/src", imageRef: REF })).toBe(
      `docker build --tag '${REF}' '/work/src'`,
    );
  });

  test("git URL context builds natively (no clone step)", () => {
    const cmd = buildAppImageBuildCmd({
      context: "https://github.com/u/repo.git#main",
      imageRef: REF,
    });
    expect(cmd).toContain("'https://github.com/u/repo.git#main'");
  });

  test("push implies buildx + --push (no --load)", () => {
    const cmd = buildAppImageBuildCmd({ context: "/c", imageRef: REF, push: true });
    expect(cmd.startsWith("docker buildx build")).toBe(true);
    expect(cmd).toContain("--push");
    expect(cmd).not.toContain("--load");
  });

  test("buildx without push gets --load so the image lands locally", () => {
    const cmd = buildAppImageBuildCmd({ context: "/c", imageRef: REF, buildx: true });
    expect(cmd).toContain("docker buildx build");
    expect(cmd).toContain("--load");
    expect(cmd).not.toContain("--push");
  });

  test("dockerfile + build args are quoted", () => {
    const cmd = buildAppImageBuildCmd({
      context: "/c",
      imageRef: REF,
      dockerfile: "docker/Dockerfile.prod",
      buildArgs: { NODE_ENV: "production" },
    });
    expect(cmd).toContain("--file 'docker/Dockerfile.prod'");
    expect(cmd).toContain("--build-arg 'NODE_ENV=production'");
  });

  test("shell-quotes a context with metacharacters (injection-safe)", () => {
    const cmd = buildAppImageBuildCmd({ context: "/c; rm -rf /", imageRef: REF });
    expect(cmd).toContain("'/c; rm -rf /'");
    expect(cmd).not.toMatch(/ rm -rf \/$/); // never bare
  });

  test("builderName pins --builder and implies buildx", () => {
    const cmd = buildAppImageBuildCmd({
      context: "/c",
      imageRef: REF,
      builderName: "b1",
      push: true,
    });
    expect(cmd.startsWith("docker buildx build")).toBe(true);
    expect(cmd).toContain("--builder 'b1'");
  });

  test("noCache adds --no-cache", () => {
    const cmd = buildAppImageBuildCmd({ context: "/c", imageRef: REF, noCache: true });
    expect(cmd).toContain("--no-cache");
  });
});

describe("isolatedBuilderName", () => {
  test("derives a DNS/Docker-safe name from appId + suffix", () => {
    const name = isolatedBuilderName("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "deadbeef00ff");
    expect(name).toBe("apps-build-aaaaaaaaaaaa-deadbeef00ff");
    // only [a-z0-9-]
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  test("strips unsafe characters from both parts", () => {
    expect(isolatedBuilderName("AB/cd:ef", "X Y!Z")).toBe("apps-build-abcdef-xyz");
  });
});

describe("buildIsolatedAppImageScript — throwaway isolated builder (BLOCKER #6)", () => {
  const SCRIPT = buildIsolatedAppImageScript({
    context: "https://github.com/u/repo.git#main",
    imageRef: REF,
    dockerfile: "Dockerfile",
    push: true,
    builderName: "apps-build-aaaaaaaaaaaa-deadbeef",
  });

  test("creates a fresh docker-container BuildKit isolated from the host daemon", () => {
    expect(SCRIPT).toContain(
      "docker buildx create --driver docker-container --name 'apps-build-aaaaaaaaaaaa-deadbeef' --bootstrap",
    );
  });

  test("guarantees teardown of the throwaway builder on EXIT", () => {
    expect(SCRIPT).toContain("trap 'docker buildx rm --force 'apps-build-aaaaaaaaaaaa-deadbeef'");
    expect(SCRIPT).toContain("EXIT");
  });

  test("aborts the build if the isolated builder cannot be created (set -e)", () => {
    const lines = SCRIPT.split("\n");
    expect(lines[0]).toBe("set -e");
    // create must come before the build so a create failure aborts pre-build
    const createIdx = lines.findIndex((l) => l.includes("buildx create"));
    const buildIdx = lines.findIndex((l) => l.includes("buildx build"));
    expect(createIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(createIdx);
  });

  test("pins the build to the throwaway builder and pushes from inside it", () => {
    expect(SCRIPT).toContain("docker buildx build --builder 'apps-build-aaaaaaaaaaaa-deadbeef'");
    expect(SCRIPT).toContain("--push");
    // never loads the untrusted image into the host daemon's image store
    expect(SCRIPT).not.toContain("--load");
  });

  test("shell-quotes an injection-laced context (defense in depth)", () => {
    const script = buildIsolatedAppImageScript({
      context: "https://x/r.git#$(touch /pwned)",
      imageRef: REF,
      builderName: "b2",
    });
    expect(script).toContain("'https://x/r.git#$(touch /pwned)'");
  });
});

describe("buildAppImagePushCmd", () => {
  test("quotes the ref", () => {
    expect(buildAppImagePushCmd(REF)).toBe(`docker push '${REF}'`);
  });
});
