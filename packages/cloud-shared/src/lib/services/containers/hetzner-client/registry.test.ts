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

const { getImageRegistryHost, loginToImageRegistry } = await import("./registry");

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
