/**
 * CONTACT create on a real PGlite runtime with the real RelationshipsService.
 * Two people can share a display name, including when both requests arrive in
 * the same millisecond.
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
import { afterEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

it("creates two contacts with the same name in one millisecond", async () => {
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
  const run = (parameters: Record<string, unknown>) =>
    contactAction.handler(
      runtime,
      {
        id: uuidv4() as UUID,
        entityId: owner,
        roomId,
        agentId: runtime.agentId,
        content: { text: "create contact", source: "test" },
      } as Memory,
      undefined,
      { parameters } as HandlerOptions,
    );

  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const first = await run({
    action: "create",
    name: "Alex Kim",
    email: "alex.one@example.com",
  });
  const second = await run({
    action: "create",
    name: "Alex Kim",
    email: "alex.two@example.com",
  });

  expect(first?.success).toBe(true);
  expect(second?.success).toBe(true);
  expect(second?.values?.entityId).not.toBe(first?.values?.entityId);
  const matches = await relationships.searchContacts({
    searchTerm: "Alex Kim",
  });
  expect(matches.map((contact) => contact.entityId).sort()).toEqual(
    [first?.values?.entityId, second?.values?.entityId].sort(),
  );
});
