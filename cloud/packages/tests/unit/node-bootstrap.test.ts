import { describe, expect, test } from "bun:test";
import { buildContainerNodeUserData } from "@/lib/services/containers/node-bootstrap";

describe("container node bootstrap", () => {
  test("disables root password expiry so SSH key automation can run commands", () => {
    const userData = buildContainerNodeUserData({
      nodeId: "node-test",
      controlPlanePublicKey: "ssh-ed25519 AAAATEST control",
      prePullImages: [],
    });

    expect(userData).toContain("ssh_pwauth: false");
    expect(userData).toContain("chpasswd:\n  expire: false");
    expect(userData).toContain("chage -M 99999 -E -1 root || true");
  });

  test("pre-pulls the managed agent image for the configured platform", () => {
    const userData = buildContainerNodeUserData({
      nodeId: "node-test",
      controlPlanePublicKey: "ssh-ed25519 AAAATEST control",
      prePullImages: ["ghcr.io/elizaos/eliza:latest"],
      prePullPlatform: "linux/amd64",
    });

    expect(userData).toContain(
      "docker pull --platform 'linux/amd64' 'ghcr.io/elizaos/eliza:latest'",
    );
  });
});
