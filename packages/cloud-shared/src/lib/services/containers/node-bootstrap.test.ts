import { afterEach, describe, expect, test } from "bun:test";
import { buildContainerNodeUserData } from "./node-bootstrap";

const REGISTRY_ENV_KEYS = [
  "CONTAINERS_REGISTRY_TOKEN",
  "ELIZA_APP_IMAGE_REGISTRY_TOKEN",
  "GHCR_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CR_PAT",
  "CONTAINERS_REGISTRY_USERNAME",
  "ELIZA_APP_IMAGE_REGISTRY_USERNAME",
  "GHCR_USERNAME",
  "GITHUB_ACTOR",
];

function clearRegistryEnv(): void {
  for (const key of REGISTRY_ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  clearRegistryEnv();
});

const baseInput = {
  nodeId: "node-1",
  controlPlanePublicKey: "ssh-ed25519 AAAA root@cp",
};

describe("buildContainerNodeUserData — ghcr access", () => {
  test("clears stale ghcr creds (logout) when no registry token is configured", () => {
    clearRegistryEnv();
    const userData = buildContainerNodeUserData(baseInput);
    expect(userData).toContain("docker logout 'ghcr.io' >/dev/null 2>&1 || true");
    expect(userData).not.toContain("docker login");
  });

  test("logs in (no logout) when a registry token + username are configured", () => {
    clearRegistryEnv();
    process.env.GHCR_TOKEN = "ghp_test_token";
    process.env.GHCR_USERNAME = "robot";
    const userData = buildContainerNodeUserData(baseInput);
    expect(userData).toContain("docker login 'ghcr.io'");
    expect(userData).toContain("--password-stdin");
    expect(userData).not.toContain("docker logout");
  });

  test("ghcr-access step runs after the bridge network and before the pre-pull", () => {
    clearRegistryEnv();
    const userData = buildContainerNodeUserData(baseInput);
    const networkIdx = userData.indexOf("docker network create");
    const accessIdx = userData.indexOf("docker logout 'ghcr.io'");
    const pullIdx = userData.indexOf("docker pull");
    expect(networkIdx).toBeGreaterThanOrEqual(0);
    expect(accessIdx).toBeGreaterThan(networkIdx);
    expect(pullIdx).toBeGreaterThan(accessIdx);
  });
});
