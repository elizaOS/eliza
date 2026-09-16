import type { IAgentRuntime } from "@elizaos/core";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudManagedGatewayRelayService } from "../../src/services/cloud-managed-gateway-relay";

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_SOURCE",
  "STEWARD_AGENT_TOKEN",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Relay Test" },
    getService: () => null,
    messageService: undefined,
  } as unknown as IAgentRuntime;
}

async function relayStatus(): Promise<string> {
  const service = (await CloudManagedGatewayRelayService.start(
    makeRuntime()
  )) as CloudManagedGatewayRelayService;
  return service.getSessionInfo().status;
}

describe("CloudManagedGatewayRelayService development Cloud authority", () => {
  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it("does not suppress the local relay after staging-default env pollution", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";

    expect(await relayStatus()).toBe("idle");

    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "late-production-token";

    expect(await relayStatus()).toBe("idle");
  });

  it("keeps an explicit production relay suppressed after late env clearing", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "production";
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_API_TOKEN = "launch-api-token";

    expect(await relayStatus()).toBe("stopped");

    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_API_TOKEN;

    expect(await relayStatus()).toBe("stopped");
  });
});
