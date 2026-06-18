import { beforeEach, describe, expect, mock, test } from "bun:test";
import { containersEnv as actualContainersEnv } from "../../../config/containers-env";

const registryUsername = mock(() => undefined as string | undefined);
const registryToken = mock(() => undefined as string | undefined);
const registryTokenFile = mock(() => undefined as string | undefined);

// Spread the real containersEnv so this process-global mock.module only
// overrides the registry-credential accessors. bun's mock.module leaks across
// files in a single test process; a partial object would make every other
// method undefined for whichever file imports after this one (order varies by
// platform → Windows failures).
mock.module("../../../config/containers-env", () => ({
  containersEnv: {
    ...actualContainersEnv,
    registryUsername,
    registryToken,
    registryTokenFile,
  },
}));

const { getImageRegistryHost, loginToImageRegistry, ensureRegistryAccess } = await import(
  "./registry"
);

describe("getImageRegistryHost", () => {
  test("returns ghcr.io for fully qualified GHCR refs", () => {
    expect(getImageRegistryHost("ghcr.io/elizaos/eliza:stable")).toBe("ghcr.io");
  });

  test("returns null for implicit docker hub refs", () => {
    expect(getImageRegistryHost("library/nginx:latest")).toBeNull();
  });
});

describe("loginToImageRegistry", () => {
  beforeEach(() => {
    registryUsername.mockReset();
    registryToken.mockReset();
    registryTokenFile.mockReset();
    registryUsername.mockReturnValue(undefined);
    registryToken.mockReturnValue(undefined);
    registryTokenFile.mockReturnValue(undefined);
  });

  test("skips login for public GHCR pulls when credentials are not configured", async () => {
    const exec = mock(async () => "");
    await loginToImageRegistry({ exec } as never, "ghcr.io/elizaos/eliza:stable");
    expect(exec).not.toHaveBeenCalled();
  });

  test("logs in when registry credentials are configured", async () => {
    registryUsername.mockReturnValue("robot");
    registryToken.mockReturnValue("ghp_test_token");
    const exec = mock(async () => "");
    await loginToImageRegistry({ exec } as never, "ghcr.io/elizaos/eliza:stable");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toContain("docker login 'ghcr.io'");
  });
});

describe("ensureRegistryAccess", () => {
  beforeEach(() => {
    registryUsername.mockReset();
    registryToken.mockReset();
    registryTokenFile.mockReset();
    registryUsername.mockReturnValue(undefined);
    registryToken.mockReturnValue(undefined);
    registryTokenFile.mockReturnValue(undefined);
  });

  test("logs out the registry host when NO token is configured (clears stale cred)", async () => {
    const exec = mock(async () => "");
    await ensureRegistryAccess({ exec } as never, "ghcr.io/elizaos/eliza:stable");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toContain("docker logout 'ghcr.io'");
  });

  test("logs in (no logout) when a registry token IS configured", async () => {
    registryUsername.mockReturnValue("robot");
    registryToken.mockReturnValue("ghp_test_token");
    const exec = mock(async () => "");
    await ensureRegistryAccess({ exec } as never, "ghcr.io/elizaos/eliza:stable");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toContain("docker login 'ghcr.io'");
    expect(exec.mock.calls[0]?.[0]).not.toContain("docker logout");
  });

  test("is a no-op for implicit docker-hub refs (no registry host)", async () => {
    const exec = mock(async () => "");
    await ensureRegistryAccess({ exec } as never, "library/nginx:latest");
    expect(exec).not.toHaveBeenCalled();
  });

  test("swallows a logout failure (best-effort, never blocks the pull)", async () => {
    const exec = mock(async () => {
      throw new Error("ssh boom");
    });
    await expect(
      ensureRegistryAccess({ exec } as never, "ghcr.io/elizaos/eliza:stable"),
    ).resolves.toBeUndefined();
  });

  test("swallows a login failure when a token is configured", async () => {
    registryUsername.mockReturnValue("robot");
    registryToken.mockReturnValue("ghp_test_token");
    const exec = mock(async () => {
      throw new Error("ssh boom");
    });
    await expect(
      ensureRegistryAccess({ exec } as never, "ghcr.io/elizaos/eliza:stable"),
    ).resolves.toBeUndefined();
  });
});
