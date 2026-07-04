/**
 * Real-database error-policy tests for SQL adapter methods that previously
 * hid adapter failures behind empty success values. Each case corrupts the
 * underlying schema and asserts the public method throws a typed `ElizaError`.
 */
import { type Component, ElizaError, type Entity, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

async function dropTable(db: DrizzleDatabase, tableName: string): Promise<void> {
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`));
}

async function expectElizaError(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ElizaError);
  expect(thrown).toMatchObject({ code });
  expect((thrown as ElizaError).cause).toBeDefined();
}

describe("SQL adapter error policy", () => {
  it("throws a typed error when countAgents cannot read the agents table", async () => {
    const setup = await createIsolatedTestDatabase("error-policy-count-agents");
    try {
      await dropTable(setup.adapter.getDatabase() as DrizzleDatabase, "agents");

      await expectElizaError(setup.adapter.countAgents(), "DB_COUNT_AGENTS_FAILED");
    } finally {
      await setup.cleanup();
    }
  });

  it("throws a typed error when deleteAgents cannot write the agents table", async () => {
    const setup = await createIsolatedTestDatabase("error-policy-delete-agents");
    try {
      await dropTable(setup.adapter.getDatabase() as DrizzleDatabase, "agents");

      await expectElizaError(
        setup.adapter.deleteAgents([uuidv4() as UUID]),
        "DB_DELETE_AGENTS_FAILED"
      );
    } finally {
      await setup.cleanup();
    }
  });

  it("throws a typed error when createEntities cannot write the entities table", async () => {
    const setup = await createIsolatedTestDatabase("error-policy-create-entities");
    try {
      await dropTable(setup.adapter.getDatabase() as DrizzleDatabase, "entities");

      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: setup.testAgentId,
        names: ["Error Policy Entity"],
      };
      await expectElizaError(setup.adapter.createEntities([entity]), "DB_CREATE_ENTITIES_FAILED");
    } finally {
      await setup.cleanup();
    }
  });

  it("throws a typed error when updateComponent cannot write the components table", async () => {
    const setup = await createIsolatedTestDatabase("error-policy-update-component");
    try {
      await dropTable(setup.adapter.getDatabase() as DrizzleDatabase, "components");

      const component: Component = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        agentId: setup.testAgentId,
        roomId: uuidv4() as UUID,
        worldId: uuidv4() as UUID,
        sourceEntityId: uuidv4() as UUID,
        type: "error-policy-component",
        data: { value: "boom" },
        createdAt: Date.now(),
      };
      await expectElizaError(
        setup.adapter.updateComponent(component),
        "DB_UPDATE_COMPONENT_FAILED"
      );
    } finally {
      await setup.cleanup();
    }
  });
});
