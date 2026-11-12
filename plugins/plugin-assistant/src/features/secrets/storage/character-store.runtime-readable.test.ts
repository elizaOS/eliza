/**
 * A secret the owner sets in chat must be readable through
 * `runtime.getSetting`, which is how every plugin reads its API key, and must
 * not disable a key that was loaded at boot.
 */
import { AgentRuntime, type IAgentRuntime, stringToUuid } from "@elizaos/core";
import { expect, it } from "vitest";
import { SecretsService } from "../services/secrets.ts";

it("exposes a secret set in chat through runtime.getSetting", async () => {
  const agentId = stringToUuid("agent");
  const ownerId = stringToUuid("owner");
  // initialize() aliases character.secrets and character.settings.secrets to
  // one object once an agent row exists.
  const secrets: Record<string, unknown> = { OPENAI_API_KEY: "sk-old" };
  // The real getSetting/setSetting over a minimal character; no adapter.
  const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
    agentId,
    character: {
      name: "Secrets",
      bio: [],
      secrets,
      settings: {
        secrets,
        ELIZA_ADMIN_ENTITY_ID: ownerId,
        ENCRYPTION_SALT: "x".repeat(32),
      },
    },
    settings: {},
  }) as IAgentRuntime;

  const service = new SecretsService(runtime);
  const context = { level: "global" as const, agentId, requesterId: ownerId };
  expect(runtime.getSetting("OPENAI_API_KEY")).toBe("sk-old");

  await service.set("OPENAI_API_KEY", "sk-new", context, { encrypted: true });

  expect({
    runtimeReads: runtime.getSetting("OPENAI_API_KEY"),
    serviceReads: await service.get("OPENAI_API_KEY", context),
  }).toEqual({ runtimeReads: "sk-new", serviceReads: "sk-new" });

  // The record stays out of the character: the agent export strips only the
  // declared secret containers, so anything else under settings would ship.
  await service.set("PLAIN_KEY", "plain-value", context, { encrypted: false });
  const { secrets: _declared, ...rest } = runtime.character.settings ?? {};
  const outsideDeclared = JSON.stringify({
    ...runtime.character,
    secrets: undefined,
    settings: rest,
  });
  for (const leaked of ["sk-new", "plain-value", "authTag", "keyId"]) {
    expect(outsideDeclared).not.toContain(leaked);
  }

  await service.delete("OPENAI_API_KEY", context);
  expect({
    runtimeReads: runtime.getSetting("OPENAI_API_KEY"),
    serviceReads: await service.get("OPENAI_API_KEY", context),
    exists: await service.exists("OPENAI_API_KEY", context),
    inSecrets: "OPENAI_API_KEY" in secrets,
  }).toEqual({
    runtimeReads: null,
    serviceReads: null,
    exists: false,
    inSecrets: false,
  });
});
