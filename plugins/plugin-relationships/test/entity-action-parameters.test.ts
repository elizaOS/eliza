/**
 * The KNOWLEDGE_GRAPH action is only reachable through the planner, which
 * validates every argument against the action's declared parameters before
 * the handler runs. The declared parameters must therefore cover what the
 * handler reads, or no entity can ever be created, read, listed or linked.
 */
import { promoteSubactionsToActions, validateToolArgs } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { entityAction } from "../src/actions/entity.ts";

describe("KNOWLEDGE_GRAPH declared parameters", () => {
  it("accepts the arguments the handler reads for every op", () => {
    const calls = [
      { action: "list" },
      { action: "list", kind: "person", limit: 5 },
      { action: "create", kind: "organization", name: "Acme" },
      { action: "read", entityId: "entity-1" },
      {
        action: "log_interaction",
        entityId: "entity-1",
        platform: "slack",
        direction: "inbound",
        summary: "asked about the invoice",
      },
      {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "entity-1",
        relationshipType: "manages",
        evidence: "org chart",
      },
    ];
    for (const args of calls) {
      const result = validateToolArgs(entityAction, args);
      expect(result.errors, JSON.stringify(args)).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it("promotes one planner tool per op with that op's required fields", () => {
    const promoted = promoteSubactionsToActions(entityAction);
    expect(
      promoted
        .map((action) => action.name)
        .filter((name) => name !== entityAction.name)
        .sort(),
    ).toEqual([
      "KNOWLEDGE_GRAPH_CREATE",
      "KNOWLEDGE_GRAPH_LIST",
      "KNOWLEDGE_GRAPH_LOG_INTERACTION",
      "KNOWLEDGE_GRAPH_READ",
      "KNOWLEDGE_GRAPH_SET_RELATIONSHIP",
    ]);
    const create = promoted.find((a) => a.name === "KNOWLEDGE_GRAPH_CREATE");
    if (!create) throw new Error("KNOWLEDGE_GRAPH_CREATE was not promoted");
    expect(validateToolArgs(create, { name: "Acme" }).valid).toBe(true);
    expect(validateToolArgs(create, {}).valid).toBe(false);
  });

  it("still rejects an unknown op and an unknown argument", () => {
    expect(validateToolArgs(entityAction, { action: "merge" }).valid).toBe(
      false,
    );
    expect(
      validateToolArgs(entityAction, { action: "list", colour: "red" }).valid,
    ).toBe(false);
  });
});
