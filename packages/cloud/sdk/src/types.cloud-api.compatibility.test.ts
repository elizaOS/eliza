import { describe, expect, test } from "vitest";
import type { AgentListItemDto } from "./types.cloud-api.js";

describe("AgentListItemDto public compatibility", () => {
  test("legacy consumers may omit current normalized agent fields", () => {
    const legacyAgent = {
      id: "agent-legacy",
      agentName: null,
      status: "stopped",
      databaseStatus: "none",
      lastBackupAt: null,
      lastHeartbeatAt: null,
      errorMessage: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      token_address: null,
      token_chain: null,
      token_name: null,
      token_ticker: null,
    } satisfies AgentListItemDto;

    expect(legacyAgent.id).toBe("agent-legacy");
  });

  test("existing consumers may use execution tiers outside the strict projection", () => {
    const existingAgent = {
      id: "agent-custom-tier",
      agentName: null,
      status: "stopped",
      databaseStatus: "none",
      lastBackupAt: null,
      lastHeartbeatAt: null,
      errorMessage: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      token_address: null,
      token_chain: null,
      token_name: null,
      token_ticker: null,
      executionTier: "legacy-dedicated",
    } satisfies AgentListItemDto;

    expect(existingAgent.executionTier).toBe("legacy-dedicated");
  });
});
