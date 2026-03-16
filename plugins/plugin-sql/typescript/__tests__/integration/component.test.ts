import {
  type AgentRuntime,
  ChannelType,
  type Component,
  type Entity,
  type Room,
  stringToUuid,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Component Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  let testSourceEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("component-tests");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testWorldId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;
    testEntityId = uuidv4() as UUID;
    testSourceEntityId = uuidv4() as UUID;

    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "Test World",
      serverId: "test-server",
    } as World);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
      {
        id: testSourceEntityId,
        agentId: testAgentId,
        names: ["Source Entity"],
      } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Component Tests", () => {
    it("should create and retrieve a basic component", async () => {
      const component: Component = {
        id: stringToUuid("a0000000-0000-0000-0000-000000000001"),
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        type: "test_component",
        data: { value: "test" },
        worldId: testWorldId,
        sourceEntityId: testSourceEntityId,
        createdAt: new Date(),
      };

      await adapter.createComponent(component);
      const retrieved = await adapter.getComponent(testEntityId, "test_component");
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(component.id);
      expect(retrieved?.data).toEqual({ value: "test" });
    });

    it("should update an existing component", async () => {
      const originalComponent: Component = {
        id: stringToUuid("a0000000-0000-0000-0000-000000000002"),
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        type: "updatable_component",
        data: { value: "original" },
        worldId: testWorldId,
        sourceEntityId: testSourceEntityId,
        createdAt: new Date(),
      };
      await adapter.createComponent(originalComponent);

      const updatedComponent: Component = {
        ...originalComponent,
        data: { value: "updated" },
      };
      await adapter.updateComponent(updatedComponent);

      const retrieved = await adapter.getComponent(testEntityId, "updatable_component");
      expect(retrieved).toBeDefined();
      expect(retrieved?.data).toEqual({ value: "updated" });
    });

    it("should delete a component", async () => {
      const component: Component = {
        id: stringToUuid("a0000000-0000-0000-0000-000000000003"),
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        type: "deletable_component",
        data: { value: "original" },
        worldId: testWorldId,
        sourceEntityId: testSourceEntityId,
        createdAt: new Date(),
      };
      await adapter.createComponent(component);
      let retrieved = await adapter.getComponent(testEntityId, "deletable_component");
      expect(retrieved).toBeDefined();

      await adapter.deleteComponent(component.id);
      retrieved = await adapter.getComponent(testEntityId, "deletable_component");
      expect(retrieved).toBeNull();
    });

    describe("patchComponent", () => {
      let componentId: UUID;
      
      beforeAll(async () => {
        const component: Component = {
          id: stringToUuid("a0000000-0000-0000-0000-000000000004"),
          entityId: testEntityId,
          agentId: testAgentId,
          roomId: testRoomId,
          type: "patchable_component",
          data: { 
            nested: { value: "initial" },
            array: ["first"],
            removable: "delete-me",
            counter: 100
          },
          worldId: testWorldId,
          sourceEntityId: testSourceEntityId,
          createdAt: new Date(),
        };
        await adapter.createComponent(component);
        componentId = component.id;
      });

      it("should set a nested value", async () => {
        await adapter.patchComponent(componentId, [
          { op: 'set', path: 'nested.value', value: "updated" }
        ]);

        const component = await adapter.getComponent(testEntityId, "patchable_component");
        expect(component?.data.nested.value).toBe("updated");
      });

      it("should push to an array", async () => {
        await adapter.patchComponent(componentId, [
          { op: 'push', path: 'array', value: "second" }
        ]);

        const component = await adapter.getComponent(testEntityId, "patchable_component");
        expect(component?.data.array).toEqual(["first", "second"]);
      });

      it("should remove a key", async () => {
        await adapter.patchComponent(componentId, [
          { op: 'remove', path: 'removable' }
        ]);

        const component = await adapter.getComponent(testEntityId, "patchable_component");
        expect(component?.data.removable).toBeUndefined();
      });

      it("should increment a numeric value", async () => {
        await adapter.patchComponent(componentId, [
          { op: 'increment', path: 'counter', value: 50 }
        ]);

        const component = await adapter.getComponent(testEntityId, "patchable_component");
        expect(component?.data.counter).toBe(150);
      });

      it("should throw on invalid path characters", async () => {
        await expect(adapter.patchComponent(componentId, [
          { op: 'set', path: 'nested.invalid!', value: "bad" }
        ])).rejects.toThrow(/Invalid patch path/);
      });

      it("should throw on component not found", async () => {
        const nonExistentId = stringToUuid("a0000000-0000-0000-0000-000000000099");
        await expect(adapter.patchComponent(nonExistentId, [
          { op: 'set', path: 'test', value: true }
        ])).rejects.toThrow(/Component not found/);
      });

      it("should throw on increment of non-numeric", async () => {
        await expect(adapter.patchComponent(componentId, [
          { op: 'increment', path: 'nested.value', value: 1 }
        ])).rejects.toThrow(/Cannot increment non-numeric/);
      });

      it("should throw on push to non-array", async () => {
        await expect(adapter.patchComponent(componentId, [
          { op: 'push', path: 'nested.value', value: "bad" }
        ])).rejects.toThrow(/Cannot push to non-array/);
      });
    });
  });
});
