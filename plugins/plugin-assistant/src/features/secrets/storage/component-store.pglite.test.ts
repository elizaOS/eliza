/**
 * Proves user-level secrets persist on the SQL adapter. ComponentSecretStorage
 * stores each one as a component on the user entity; the components table has
 * foreign keys to rooms and worlds (plugins/plugin-sql/src/schema/component.ts),
 * and the runtime creates a room with the agent's id but no such world. A stub
 * runtime cannot see those keys, so this runs the shipped secrets plugin over a
 * real PGLite-backed AgentRuntime.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  ChannelType,
  type HandlerOptions,
  type Memory,
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

const USER_ID = "c5e70000-0000-4000-8000-000000000001" as UUID;
const WORLD_ID = "c5e70000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "c5e70000-0000-4000-8000-000000000003" as UUID;

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let secrets: SecretsService;

beforeAll(async () => {
  const created = await createTestRuntime({
    characterName: "UserSecretComponentPgliteTest",
    settings: { ENCRYPTION_SALT: "component-store-pglite-test-salt" },
    plugins: [secretsManagerPlugin],
  });
  runtime = created.runtime;
  cleanup = created.cleanup;
  await runtime.ensureConnection({
    entityId: USER_ID,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    worldName: "User secret PGLite test",
    userName: "Secret owner",
    name: "Secret owner",
    source: "test",
    type: ChannelType.DM,
  });
  secrets = (await runtime.getServiceLoadPromise(
    SECRETS_SERVICE_TYPE,
  )) as SecretsService;
}, 120_000);

afterAll(async () => {
  await cleanup?.();
}, 120_000);

describe("ComponentSecretStorage on PGLite", () => {
  it("stores, replaces and deletes a user secret", async () => {
    await expect(
      secrets.setUser("USER_TOKEN", "first-value", USER_ID),
    ).resolves.toBe(true);
    expect(await secrets.getUser("USER_TOKEN", USER_ID)).toBe("first-value");

    await expect(
      secrets.setUser("USER_TOKEN", "second-value", USER_ID),
    ).resolves.toBe(true);
    expect(await secrets.getUser("USER_TOKEN", USER_ID)).toBe("second-value");

    const context = {
      level: "user" as const,
      userId: USER_ID,
      agentId: runtime.agentId,
      requesterId: USER_ID,
    };
    expect(Object.keys(await secrets.list(context))).toEqual(["USER_TOKEN"]);
    await expect(secrets.delete("USER_TOKEN", context)).resolves.toBe(true);
    expect(await secrets.getUser("USER_TOKEN", USER_ID)).toBeNull();
  });

  it("stores a user secret through the SECRETS action in a DM", async () => {
    const result = await setSecretHandler(
      runtime,
      {
        id: "c5e70000-0000-4000-8000-000000000004" as UUID,
        entityId: USER_ID,
        roomId: ROOM_ID,
        agentId: runtime.agentId,
        content: { text: "store my token", channelType: ChannelType.DM },
      } as Memory,
      undefined,
      {
        parameters: { key: "DM_TOKEN", value: "dm-value", level: "user" },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(await secrets.getUser("DM_TOKEN", USER_ID)).toBe("dm-value");
  });
});
