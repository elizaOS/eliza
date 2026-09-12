/**
 * Exercises CONTACT creation through AgentRuntime, RelationshipsService and
 * PGlite, including complete field persistence and a database write fault.
 */
import { type Memory, stringToUuid, type UUID } from "@elizaos/core";
import type { RelationshipsService } from "@elizaos/core/services/relationships";
import {
  createTestRuntime,
  type TestRuntimeResult,
} from "@elizaos/core/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactAction } from "./contact.ts";

describe("CONTACT persisted creation", () => {
  let harness: TestRuntimeResult;
  let service: RelationshipsService;
  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "ContactPersistenceProof",
    });
    service = (await harness.runtime.getServiceLoadPromise(
      "relationships",
    )) as RelationshipsService;
  }, 180_000);
  afterAll(async () => {
    await harness?.cleanup();
  });

  async function create(id: UUID, overrides: Record<string, unknown> = {}) {
    const result = await contactAction.handler(
      harness.runtime,
      {
        id: stringToUuid(`message-${id}`),
        entityId: harness.runtime.agentId,
        agentId: harness.runtime.agentId,
        roomId: stringToUuid("contact-proof-room"),
        content: { text: "Create synthetic audit contact", source: "test" },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "create",
          entityId: id,
          name: "Audit Person",
          email: "audit@example.invalid",
          categories: ["friend"],
          tags: ["studio", "weekly"],
          preferences: { timezone: "UTC" },
          customFields: { project: "Cedar", source: "audit" },
          ...overrides,
        },
      } as never,
    );
    if (!result) throw new Error("CONTACT returned no result");
    return result;
  }

  it("persists every requested field and returns the stored contact receipt", async () => {
    const id = stringToUuid("contact-persisted-complete");
    const result = await create(id);
    expect(result.success).toBe(true);
    const entity = await harness.runtime.getEntityById(id);
    expect(entity?.metadata).toMatchObject({ email: "audit@example.invalid" });
    const component = await harness.runtime.getComponent(id, "contact_info");
    expect(component?.data).toMatchObject({
      categories: ["friend"],
      tags: ["studio", "weekly"],
      preferences: { timezone: "UTC" },
      customFields: {
        project: "Cedar",
        source: "audit",
        displayName: "Audit Person",
      },
    });
    if (!component?.data)
      throw new Error("Contact component was not persisted");
    expect(result.data?.contact).toMatchObject(component.data);
    expect((await service.getContact(id))?.tags).toEqual(["studio", "weekly"]);
  });

  it("rolls back a new entity when the real database rejects contact fields", async () => {
    const id = stringToUuid("contact-persisted-rollback");
    const db = harness.runtime.adapter.db;
    if (!db || !("execute" in db) || typeof db.execute !== "function")
      throw new Error("PGlite SQL unavailable");
    await db.execute(
      sql.raw(
        `ALTER TABLE components ADD CONSTRAINT audit_contact_write_fault CHECK (entity_id <> '${id}'::uuid)`,
      ),
    );
    try {
      const result = await create(id);
      expect(result.success).toBe(false);
      expect(await harness.runtime.getEntityById(id)).toBeNull();
      expect(await harness.runtime.getComponent(id, "contact_info")).toBeNull();
      expect(await service.getContact(id)).toBeNull();
    } finally {
      await db.execute(
        sql.raw(
          "ALTER TABLE components DROP CONSTRAINT audit_contact_write_fault",
        ),
      );
    }
  });

  it("does not replace existing contact fields when creation is repeated", async () => {
    const id = stringToUuid("contact-persisted-repeat");
    expect((await create(id)).success).toBe(true);
    const before = await harness.runtime.getComponent(id, "contact_info");
    const result = await create(id, {
      tags: ["overwrite"],
      customFields: { project: "Changed" },
    });
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "CONTACT_ALREADY_EXISTS" });
    expect(await harness.runtime.getComponent(id, "contact_info")).toEqual(
      before,
    );
  });
});
