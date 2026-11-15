import { readFileSync } from "node:fs";
import { ChannelType, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { secretsManagerPlugin } from "../plugin.ts";
import {
  SECRETS_SERVICE_TYPE,
  type SecretsService,
} from "../services/secrets.ts";

interface StoreCase {
  scenario: number;
  storedCount: number;
  worldExists?: boolean;
  metadataKept?: boolean;
}
const input: { model: string; cases: StoreCase[] } | undefined = process.env
  .ELIZA_SECRET_STORE_CASES
  ? JSON.parse(readFileSync(process.env.ELIZA_SECRET_STORE_CASES, "utf8"))
  : undefined;
const componentCases = input
  ? input.model === "SelfWorldCreation"
    ? input.cases
    : []
  : [0, 1].map((scenario) => ({
      scenario,
      storedCount: scenario === 0 ? 2 : 1,
      worldExists: true,
      metadataKept: true,
    }));

async function createFixture() {
  const fixture = await createTestRuntime({
    characterName: "SecretStoreModel",
    settings: { ENCRYPTION_SALT: "secret-store-model-fixture" },
    plugins: [secretsManagerPlugin],
  });
  const secrets = (await fixture.runtime.getServiceLoadPromise(
    SECRETS_SERVICE_TYPE,
  )) as SecretsService;
  return { ...fixture, secrets };
}
it.each(componentCases)(
  "matches self-world creation scenario $scenario",
  async (model) => {
    const fixture = await createFixture();
    try {
      const { runtime, secrets } = fixture;
      const userId = crypto.randomUUID() as UUID;
      await runtime.ensureConnection({
        entityId: userId,
        roomId: crypto.randomUUID() as UUID,
        worldId: crypto.randomUUID() as UUID,
        worldName: "User secret fixture",
        userName: "Fixture",
        name: "Fixture",
        source: "test",
        type: ChannelType.DM,
      });
      expect(await runtime.getWorld(runtime.agentId)).toBeNull();
      if (model.scenario === 1) {
        await runtime.createWorld({
          id: runtime.agentId,
          agentId: runtime.agentId,
          metadata: { reviewMarker: "retained" },
        });
      }
      const writes = Array.from({ length: model.storedCount }, (_, index) =>
        secrets.setUser(`KEY_${index}`, `fixture-${index}`, userId),
      );
      expect(await Promise.all(writes)).toEqual(
        Array(model.storedCount).fill(true),
      );
      for (let index = 0; index < model.storedCount; index++) {
        expect(await secrets.getUser(`KEY_${index}`, userId)).toBe(
          `fixture-${index}`,
        );
      }
      const world = await runtime.getWorld(runtime.agentId);
      expect(Boolean(world)).toBe(model.worldExists);
      if (model.scenario === 1)
        expect(world?.metadata?.reviewMarker).toBe("retained");
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);
