/**
 * A follow-up's completion posts. The same session completes twice — the
 * build, then the delivered follow-up ("also add a score tracker") — and the
 * second completion, re-keyed by followUpOriginMessageId, must inject a relay
 * memory instead of dying as a duplicate terminal (live 2026-08-22: the score
 * tracker landed in the page but the room never heard about it).
 *
 * Drives the REAL SubAgentRouter.handleEvent with a fake ACP service.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SubAgentRouter } from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

type RouterInternals = {
  handleEvent(sessionId: string, event: string, data: unknown): Promise<void>;
};

function makeFakeAcp(sessions: Map<string, Record<string, unknown>>) {
  let handler: EventHandler | undefined;
  const service = {
    onSessionEvent(cb: EventHandler) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    getSessions: vi.fn(async () => [...sessions.values()]),
    getChangedPaths: vi.fn(() => [] as string[]),
    spawnSession: vi.fn(async () => ({ sessionId: "retry-1" })),
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
  };
  return { service, emit: handler };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
  created: Array<Record<string, unknown>>,
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      return undefined;
    },
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    deleteParticipants: vi.fn(async () => true),
    reportError: vi.fn(),
    createMemory: vi.fn(async (memory: Record<string, unknown>) => {
      created.push(memory);
      return MSG;
    }),
    emitEvent: vi.fn(async (_type: unknown, payload: unknown) => {
      const memory = (payload as { message?: Record<string, unknown> })
        ?.message;
      if (memory) created.push(memory);
      return undefined;
    }),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime;
}

function relayTexts(created: Array<Record<string, unknown>>): string[] {
  return created
    .map((m) => {
      const content = m.content as { text?: string } | undefined;
      return content?.text ?? "";
    })
    .filter((text) => text.includes("[sub-agent"));
}

describe("follow-up completion relay", () => {
  it("the second completion of a session posts under the follow-up's key", async () => {
    const metadata: Record<string, unknown> = {
      roomId: ROOM,
      taskRoomId: ROOM,
      messageId: MSG,
      originConnectorMessageId: "disc-build-1",
      spawnRootMessageId: MSG,
      source: "discord",
      label: "rock-paper-scissors-page",
      initialTask: "Build a rock paper scissors page",
    };
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "sess-1",
        {
          id: "sess-1",
          agentType: "elizaos",
          name: "Ada",
          workdir: "/tmp/follow-up-relay-test",
          status: "ready",
          createdAt: new Date(0),
          lastActivityAt: new Date(0),
          metadata,
        },
      ],
    ]);
    const acp = makeFakeAcp(sessions);
    const created: Array<Record<string, unknown>> = [];
    const runtime = makeRuntime(acp.service, created);
    const router = new SubAgentRouter(runtime);
    await router.start();
    const internals = router as unknown as RouterInternals;

    await internals.handleEvent("sess-1", "task_complete", {
      response: "The rock paper scissors page is ready.",
      stopReason: "end_turn",
    });
    const afterFirst = relayTexts(created).length;
    expect(afterFirst).toBeGreaterThan(0);

    // The follow-up is delivered: its origin re-keys the session's voice.
    metadata.followUpOriginMessageId = "disc-followup-2";

    await internals.handleEvent("sess-1", "task_complete", {
      response: "Added a score tracker with wins, losses, and ties.",
      stopReason: "end_turn",
    });
    const texts = relayTexts(created);
    expect(texts.length).toBeGreaterThan(afterFirst);
    expect(texts.join("\n")).toContain("score tracker");
  });
});
