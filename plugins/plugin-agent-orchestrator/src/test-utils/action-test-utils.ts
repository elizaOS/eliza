/**
 * Test fixtures for the TASKS action suite.
 * Builders for fake `SessionInfo` records and a stubbed ACP service/runtime so
 * action handlers can be driven without spawning a real subprocess.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { vi } from "vitest";
import type { SessionInfo } from "../services/types.js";

export function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-05-03T10:00:00.000Z");
  return {
    id: "abcdef123456",
    name: "agent-one",
    agentType: "codex",
    workdir: "/tmp/acp",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { label: "demo" },
    ...overrides,
  };
}

export function serviceMock(overrides: Record<string, unknown> = {}) {
  const s = session();
  return {
    defaultApprovalPreset: "standard",
    spawnSession: vi.fn(async (opts) => ({
      sessionId: s.id,
      id: s.id,
      name: s.name,
      agentType: opts.agentType ?? s.agentType,
      workdir: opts.workdir ?? s.workdir,
      status: "ready",
      metadata: opts.metadata,
    })),
    sendPrompt: vi.fn(async (sid: string) => ({
      sessionId: sid,
      response: "done",
      finalText: "done",
      stopReason: "end_turn",
      durationMs: 12,
    })),
    sendToSession: vi.fn(async (sid: string) => ({
      sessionId: sid,
      response: "ok",
      finalText: "ok",
      stopReason: "end_turn",
      durationMs: 5,
    })),
    sendKeysToSession: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    cancelSession: vi.fn(async () => undefined),
    listSessions: vi.fn(() => [s]),
    getSession: vi.fn((id: string) => (id === s.id ? s : undefined)),
    resolveAgentType: vi.fn(async () => "codex"),
    checkAvailableAgents: vi.fn(async () => [
      {
        adapter: "codex",
        agentType: "codex",
        installed: true,
        auth: { status: "unknown" },
      },
    ]),
    emitSessionEvent: vi.fn(),
    ...overrides,
  };
}

/**
 * Canonical-owner resolution for the owner-privacy read gate
 * (`requireOwnerTaskReadAccess` → core `hasRoleAccess`): the gate resolves the
 * configured `ELIZA_ADMIN_ENTITY_ID` and compares it to the message sender, so
 * returning `memory()`'s sender ("user1") makes these suites exercise the TASKS
 * read surfaces (history, list_agents, and their aliases) AS the authorized
 * owner — which is what their assertions describe. Guest denial is proven
 * separately in `src/__tests__/tasks-owner-read-gate.test.ts` with its own
 * non-owner runtime. Suites with bespoke runtime builders reuse this so the
 * owner identity lives in one place.
 */
export function ownerGetSetting(ownerEntityId = "user1") {
  return vi.fn((key: string) =>
    key === "ELIZA_ADMIN_ENTITY_ID" ? ownerEntityId : undefined,
  );
}

export function runtimeWith(service?: unknown): IAgentRuntime {
  return {
    agentId: "agent1",
    getService: vi.fn(() => service ?? null),
    // The TASKS owner-read gate runs before any service state is touched;
    // resolve the test sender as the canonical owner (see ownerGetSetting).
    getSetting: ownerGetSetting(),
    // tasks.ts validate() requires hasService — mirror getService's truthiness
    // so tests built with `runtimeWith(serviceMock())` see ACP as available.
    hasService: vi.fn(() => Boolean(service)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // The task-agent ACL (`requireTaskAgentAccess` → `resolveConnectorSource`)
    // reads the room's connector source; a source-less room is genuine
    // client-chat, which the default GUEST policy permits. Without `getRoom` the
    // lookup throws and fails closed (SOURCE_RESOLUTION_FAILED → denied), so
    // every create/interact action test would wrongly deny. `reportError` backs
    // that fail-closed path. Denial cases override the source/policy explicitly.
    getRoom: vi.fn(async () => ({ id: "room1" })),
    reportError: vi.fn(),
  } as never;
}

export function memory(content: Record<string, unknown> = {}): Memory {
  return {
    id: "msg1",
    entityId: "user1",
    agentId: "agent1",
    roomId: "room1",
    content,
    createdAt: Date.now(),
  } as never;
}

export function callback() {
  return vi.fn(async () => [] as never[]);
}

export const state = {} as State;
