/**
 * Proves world-level secrets follow the world as other writers change it.
 * WorldMetadataStorage writes the whole world through runtime.updateWorld,
 * and the SQL adapter refuses a write whose metadata revision is older than
 * the stored one (WORLD_METADATA_STALE_WRITE). Role grants commit through
 * setEntityRoleCas, the path the TRUST update_role action uses, and advance
 * that revision. A stub runtime has no revision, so this runs the shipped
 * secrets plugin over a real PGLite-backed AgentRuntime.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  ChannelType,
  type HandlerOptions,
  type Memory,
  setEntityRoleCas,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSecretHandler } from "../actions/set-secret.ts";
import { secretsManagerPlugin } from "../plugin.ts";
import {
  SECRETS_SERVICE_TYPE,
  type SecretsService,
} from "../services/secrets.ts";

const OWNER_ID = "a0e70000-0000-4000-8000-000000000001" as UUID;
const HELPER_ID = "a0e70000-0000-4000-8000-000000000002" as UUID;

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let secrets: SecretsService;

beforeAll(async () => {
  const created = await createTestRuntime({
    characterName: "WorldSecretPgliteTest",
    settings: { ENCRYPTION_SALT: "world-store-pglite-test-salt" },
    plugins: [secretsManagerPlugin],
  });
  runtime = created.runtime;
  cleanup = created.cleanup;
  secrets = (await runtime.getServiceLoadPromise(
    SECRETS_SERVICE_TYPE,
  )) as SecretsService;
}, 120_000);

afterAll(async () => {
  await cleanup?.();
}, 120_000);

async function createOwnedWorld(seed: string) {
  const worldId = `a0e70000-0000-4000-8000-0000000000${seed}` as UUID;
  const roomId = `a0e70000-0000-4000-8000-0000000001${seed}` as UUID;
  for (const entityId of [OWNER_ID, HELPER_ID]) {
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: `World secret PGLite test ${seed}`,
      userName: entityId === OWNER_ID ? "Owner" : "Helper",
      name: entityId === OWNER_ID ? "Owner" : "Helper",
      source: "test",
      type: ChannelType.GROUP,
      messageServerId: worldId,
    });
  }
  const message = {
    id: `a0e70000-0000-4000-8000-0000000002${seed}` as UUID,
    entityId: OWNER_ID,
    roomId,
    worldId,
    agentId: runtime.agentId,
    content: { text: "role change", channelType: ChannelType.GROUP },
  } as Memory;
  const owner = await setEntityRoleCas(runtime, message, OWNER_ID, "OWNER", {
    worldId,
  });
  expect(owner.status).toBe("committed");
  return { worldId, roomId, message };
}

function worldContext(worldId: UUID, requesterId: UUID) {
  return {
    level: "world" as const,
    agentId: runtime.agentId,
    worldId,
    requesterId,
  };
}

describe("WorldMetadataStorage on PGLite", () => {
  it("stores a world secret after a role grant changed the world", async () => {
    const { worldId, roomId, message } = await createOwnedWorld("11");
    const owner = worldContext(worldId, OWNER_ID);

    await expect(
      secrets.set("FIRST_SERVER_TOKEN", "first-value", owner),
    ).resolves.toBe(true);

    const grant = await setEntityRoleCas(runtime, message, HELPER_ID, "ADMIN", {
      worldId,
    });
    expect(grant.status).toBe("committed");

    await expect(
      secrets.set("SECOND_SERVER_TOKEN", "second-value", owner),
    ).resolves.toBe(true);
    expect(await secrets.get("SECOND_SERVER_TOKEN", owner)).toBe(
      "second-value",
    );

    const result = await setSecretHandler(
      runtime,
      {
        id: "a0e70000-0000-4000-8000-000000000311" as UUID,
        entityId: OWNER_ID,
        roomId,
        worldId,
        agentId: runtime.agentId,
        content: {
          text: "store the server token",
          channelType: ChannelType.DM,
        },
      } as Memory,
      undefined,
      {
        parameters: {
          key: "THIRD_SERVER_TOKEN",
          value: "third-value",
          level: "world",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);

    const stored = await runtime.getWorld(worldId);
    const storedSecrets = (
      stored?.metadata as { secrets?: Record<string, unknown> } | undefined
    )?.secrets;
    expect(Object.keys(storedSecrets ?? {}).sort()).toEqual([
      "FIRST_SERVER_TOKEN",
      "SECOND_SERVER_TOKEN",
      "THIRD_SERVER_TOKEN",
    ]);
  });

  it("lets a newly promoted admin store and read a world secret", async () => {
    const { worldId, message } = await createOwnedWorld("12");
    const owner = worldContext(worldId, OWNER_ID);
    const helper = worldContext(worldId, HELPER_ID);

    await expect(
      secrets.set("OWNER_SERVER_TOKEN", "owner-value", owner),
    ).resolves.toBe(true);

    const grant = await setEntityRoleCas(runtime, message, HELPER_ID, "ADMIN", {
      worldId,
    });
    expect(grant.status).toBe("committed");

    await expect(
      secrets.set("HELPER_SERVER_TOKEN", "helper-value", helper),
    ).resolves.toBe(true);
    expect(await secrets.get("OWNER_SERVER_TOKEN", helper)).toBe("owner-value");
    expect(await secrets.get("HELPER_SERVER_TOKEN", owner)).toBe(
      "helper-value",
    );
  });
});
