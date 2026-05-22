import { describe, expect, it } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { buildCodingContainerCreatePayload } from "./coding-containers";

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
