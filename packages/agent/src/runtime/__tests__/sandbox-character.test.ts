/**
 * Unit tests for the cloud sandbox character loader (Path A fix #1).
 */

import { describe, expect, it, vi } from "vitest";
import {
  applySandboxCharacterFromEnv,
  resolveSandboxRouteAgentId,
} from "../sandbox-character.ts";

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("applySandboxCharacterFromEnv", () => {
  it("is a no-op when ELIZA_AGENT_CHARACTER_JSON is absent", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(config, {});
    expect(out).toBe(config);
    expect((out as { agents?: { list?: unknown[] } }).agents?.list).toEqual([]);
  });

  it("merges the injected character onto config.agents.list[0]", () => {
    const character = {
      id: "char-internal",
      name: "Nyx",
      system: "You are Nyx.",
      bio: ["A mysterious agent."],
      topics: ["lore"],
      adjectives: ["sharp"],
      style: { all: ["concise"] },
    };
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify(character),
      SANDBOX_ROUTE_AGENT_ID: "char-route",
    });
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.name).toBe("Nyx");
    expect(entry.system).toBe("You are Nyx.");
    expect(entry.bio).toEqual(["A mysterious agent."]);
    // The id MUST be the routing id so runtime.agentId matches the gateway.
    expect(entry.id).toBe("char-route");
    expect(entry.default).toBe(true);
    // UI assistant name surfaces for logging/prompts.
    expect(
      (out as { ui: { assistant: { name: string } } }).ui.assistant.name,
    ).toBe("Nyx");
  });

  it("survives malformed JSON without throwing and keeps the config unchanged", () => {
    const config = { agents: { list: [] } } as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: "{ not json",
    });
    expect((out as { agents: { list: unknown[] } }).agents.list).toEqual([]);
  });

  it("falls back to AGENT_NAME when the character has no name", () => {
    const config = {} as never;
    const out = applySandboxCharacterFromEnv(config, {
      ELIZA_AGENT_CHARACTER_JSON: JSON.stringify({ system: "x" }),
      AGENT_NAME: "Nyx",
    });
    const entry = (out as { agents: { list: Array<Record<string, unknown>> } })
      .agents.list[0];
    expect(entry.name).toBe("Nyx");
  });
});

describe("resolveSandboxRouteAgentId", () => {
  it("returns the route id when present", () => {
    expect(resolveSandboxRouteAgentId({ SANDBOX_ROUTE_AGENT_ID: "abc" })).toBe(
      "abc",
    );
  });
  it("returns null when absent", () => {
    expect(resolveSandboxRouteAgentId({})).toBeNull();
  });
});
