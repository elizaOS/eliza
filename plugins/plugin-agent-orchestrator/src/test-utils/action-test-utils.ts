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

export function runtimeWith(service?: unknown): IAgentRuntime {
  return {
    getService: vi.fn(() => service ?? null),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
