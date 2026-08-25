import { describe, expect, it } from "bun:test";
import { usesLocalDockerSandboxProvider } from "./sandbox-provider";

describe("usesLocalDockerSandboxProvider", () => {
  it("selects local Docker when explicitly enabled", () => {
    expect(
      usesLocalDockerSandboxProvider({
        ELIZA_LOCAL_DOCKER_PROVIDER: "1",
        CONTAINERS_SSH_KEY_PATH: "/remote/key",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("selects local Docker for a local environment without SSH configuration", () => {
    expect(usesLocalDockerSandboxProvider({ ENVIRONMENT: "local" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  it("keeps remote-node mode when SSH is configured and local Docker is not explicit", () => {
    expect(
      usesLocalDockerSandboxProvider({
        ENVIRONMENT: "local",
        CONTAINERS_SSH_KEY_PATH: "/remote/key",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
