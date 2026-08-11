/**
 * Pins the remote managed-container pairing mode at the pure env helper and
 * the Docker provider boundary without reaching SSH or a live node.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import { applyRemoteDockerRuntimeMode } from "./remote-docker-runtime-mode";

afterEach(() => {
  mock.restore();
});

describe("applyRemoteDockerRuntimeMode", () => {
  test("preserves unrelated values while overriding a historical direct-relay opt-in", () => {
    const stored = {
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      ELIZA_API_TOKEN: "agent-token",
    };

    expect(applyRemoteDockerRuntimeMode(stored)).toEqual({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      ELIZA_API_TOKEN: "agent-token",
    });
    expect(stored.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("1");
  });
});

describe("DockerSandboxProvider remote runtime mode", () => {
  test("forces the flag before every remote create attempt", async () => {
    const provider = new DockerSandboxProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: { environmentVars: Record<string, string> }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("captured remote create config"));
    const callerEnvironment = {
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      CUSTOM_SETTING: "preserved",
    };

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Remote pairing guard",
        organizationId: "22222222-2222-4222-8222-222222222222",
        environmentVars: callerEnvironment,
      }),
    ).rejects.toThrow("captured remote create config");

    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(createOnce.mock.calls[0]?.[0].environmentVars).toMatchObject({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      CUSTOM_SETTING: "preserved",
    });
    expect(callerEnvironment.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("1");
  });
});
