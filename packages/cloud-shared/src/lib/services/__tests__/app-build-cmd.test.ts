import { describe, expect, test } from "bun:test";
import { buildAppImageBuildCmd, buildAppImagePushCmd } from "../app-build-cmd";

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
});

describe("buildAppImagePushCmd", () => {
  test("quotes the ref", () => {
    expect(buildAppImagePushCmd(REF)).toBe(`docker push '${REF}'`);
  });
});
