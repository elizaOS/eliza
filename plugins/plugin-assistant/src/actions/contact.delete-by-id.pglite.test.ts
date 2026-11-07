/**
 * CONTACT delete by entityId, on a real PGlite runtime with the real
 * RelationshipsService: the deleted contact leaves the name lookups, so a
 * later update by name neither "updates" it nor collides with a new contact
 * of the same name.
 */
import {
  AgentRuntime,
  type Character,
  type HandlerOptions,
  type Memory,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { RelationshipsService } from "../services/relationships.ts";
import { createContactActions } from "./contact.ts";

const character: Character = {
  name: "Eliza",
  bio: ["Test"],
  templates: {},
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  secrets: {},
};
const relationshipsPlugin: Plugin = {
  name: "relationships",
  description: "Contact service",
  services: [RelationshipsService],
};
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

it("removes a contact deleted by entityId from name lookups", async () => {
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, relationshipsPlugin],
    settings: { PGLITE_DATA_DIR: "memory://" },
  });
  runtimes.push(runtime);
  await runtime.initialize();
  const relationships = (await runtime.getServiceLoadPromise(
    "relationships",
  )) as unknown as RelationshipsService;
  const { contactAction } = createContactActions({
    resolveGraph: async () => null,
    hasContextSignal: () => true,
  });
  const owner = uuidv4() as UUID;
  const roomId = uuidv4() as UUID;
  const run = (parameters: Record<string, unknown>, text = "do it") =>
    contactAction.handler(
      runtime,
      {
        id: uuidv4() as UUID,
        entityId: owner,
        roomId,
        agentId: runtime.agentId,
        content: { text, source: "test" },
      } as Memory,
      undefined,
      { parameters } as HandlerOptions,
    );

  const created = await run({ action: "create", name: "Alice Park" });
  const aliceId = created?.values?.entityId as UUID;
  await run({ action: "delete", entityId: aliceId });
  const deleted = await run({ action: "delete", entityId: aliceId }, "yes");
  expect(deleted?.success).toBe(true);
  expect(await runtime.getEntityById(aliceId)).toBeNull();

  expect(await relationships.searchContacts({ searchTerm: "alice" })).toEqual(
    [],
  );
  const updateDeleted = await run({
    action: "update",
    name: "Alice",
    tags: ["vip"],
  });
  expect(updateDeleted?.success).toBe(false);

  const createdAgain = await run({ action: "create", name: "Alice Chen" });
  const updateNew = await run({
    action: "update",
    name: "Alice",
    tags: ["vip"],
  });
  expect(updateNew?.success).toBe(true);
  expect(
    (await relationships.getContact(createdAgain?.values?.entityId as UUID))
      ?.tags,
  ).toContain("vip");
}, 60_000);
