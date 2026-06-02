import { describe, expect, it } from "bun:test";
import { containersEnv } from "../config/containers-env";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import {
  buildCodingContainerCreatePayload,
  isCodingContainerImageAllowed,
} from "./coding-containers";

describe("coding container payloads", () => {
  it("uses the coding remote runner image when configured", () => {
    const payload = runWithCloudBindings(
      {
        ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE: "ghcr.io/elizaos/coding-remote-runner:test",
      },
      () =>
        buildCodingContainerCreatePayload({
          agent: "codex",
          workspacePath: "/workspace/project",
        }),
    );

    expect(payload.image).toBe("ghcr.io/elizaos/coding-remote-runner:test");
    expect(payload.port).toBe(3000);
    expect(payload.health_check_path).toBe("/health");
    expect(payload.volume_mount_path).toBe("/workspace/project");
  });

  it("lets explicit coding container image override the default", () => {
    const payload = runWithCloudBindings(
      {
        ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE: "ghcr.io/elizaos/coding-remote-runner:test",
      },
      () =>
        buildCodingContainerCreatePayload({
          agent: "opencode",
          container: { image: "ghcr.io/example/custom-coding-image:latest" },
        }),
    );

    expect(payload.image).toBe("ghcr.io/example/custom-coding-image:latest");
  });
});

describe("coding container image allowlist", () => {
  const DEFAULT = [
    "ghcr.io/dexploarer/*",
    "ghcr.io/elizaos/*",
    "ghcr.io/waifufun/*",
  ];

  it("allows images under an allowed prefix", () => {
    expect(
      isCodingContainerImageAllowed("ghcr.io/dexploarer/bnancy:latest", DEFAULT),
    ).toBe(true);
    expect(
      isCodingContainerImageAllowed("ghcr.io/elizaos/eliza:stable", DEFAULT),
    ).toBe(true);
    expect(
      isCodingContainerImageAllowed("ghcr.io/waifufun/runner:v2", DEFAULT),
    ).toBe(true);
  });

  it("rejects images outside the allowlist", () => {
    expect(
      isCodingContainerImageAllowed("docker.io/library/nginx:latest", DEFAULT),
    ).toBe(false);
    expect(
      isCodingContainerImageAllowed("ghcr.io/attacker/evil:latest", DEFAULT),
    ).toBe(false);
    // No bare-substring bypass: prefix must match from the start.
    expect(
      isCodingContainerImageAllowed(
        "evil.io/ghcr.io/elizaos/eliza:stable",
        DEFAULT,
      ),
    ).toBe(false);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(
      isCodingContainerImageAllowed("  GHCR.IO/Elizaos/Eliza:Stable  ", DEFAULT),
    ).toBe(true);
  });

  it("fails closed on an empty allowlist", () => {
    expect(isCodingContainerImageAllowed("ghcr.io/elizaos/eliza", [])).toBe(
      false,
    );
  });

  it("supports an explicit wildcard opt-out", () => {
    expect(isCodingContainerImageAllowed("anything/at/all", ["*"])).toBe(true);
  });

  it("supports exact-match entries", () => {
    expect(
      isCodingContainerImageAllowed("ghcr.io/elizaos/eliza:stable", [
        "ghcr.io/elizaos/eliza:stable",
      ]),
    ).toBe(true);
    expect(
      isCodingContainerImageAllowed("ghcr.io/elizaos/eliza:dev", [
        "ghcr.io/elizaos/eliza:stable",
      ]),
    ).toBe(false);
  });

  it("env getter returns the secure default when unset", () => {
    const allowlist = runWithCloudBindings({}, () =>
      containersEnv.codingContainerImageAllowlist(),
    );
    expect(allowlist).toEqual(DEFAULT);
  });

  it("env getter parses a comma-separated override", () => {
    const allowlist = runWithCloudBindings(
      { CODING_CONTAINER_IMAGE_ALLOWLIST: "ghcr.io/foo/*, ghcr.io/bar/baz:1 " },
      () => containersEnv.codingContainerImageAllowlist(),
    );
    expect(allowlist).toEqual(["ghcr.io/foo/*", "ghcr.io/bar/baz:1"]);
  });
});
