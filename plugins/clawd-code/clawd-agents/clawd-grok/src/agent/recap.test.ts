import { afterEach, describe, expect, it, vi } from "vitest";

async function importAgentModuleWithRecapMocks() {
  vi.resetModules();

  const generateRecap = vi.fn(async () => ({
    recap: "Recovered the latest session state.",
    modelId: "grok-4.20-non-reasoning",
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    },
  }));

  vi.doMock("../grok/client", async () => {
    const actual = await vi.importActual<typeof import("../grok/client")>("../grok/client");
    return {
      ...actual,
      generateRecap,
    };
  });

  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    appendSystemMessage: vi.fn(() => 0),
    buildChatEntries: vi.fn(() => [
      {
        type: "user",
        content: "Summarize this session.",
        timestamp: new Date("2026-04-22T15:00:00.000Z"),
      },
    ]),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  const mod = await import("./agent");
  return {
    ...mod,
    mocks: {
      generateRecap,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../grok/client");
  vi.doUnmock("../storage/index");
});

describe("Agent session recap", () => {
  it("does not throw when persisting a generated recap fails", async () => {
    const { Agent, mocks } = await importAgentModuleWithRecapMocks();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    const session = {
      id: "session-1",
      workspaceId: "workspace-1",
      title: null,
      recap: null,
      model: "grok-4.3",
      mode: "agent",
      cwdAtStart: process.cwd(),
      cwdLast: process.cwd(),
      status: "active",
      createdAt: new Date("2026-04-22T15:00:00.000Z"),
      updatedAt: new Date("2026-04-22T15:00:00.000Z"),
    };
    const sessionStore = {
      setRecap: vi.fn(() => {
        throw new Error("database is unavailable");
      }),
      getRequiredSession: vi.fn(() => session),
    };

    Object.assign(agent as object, {
      provider: {},
      session,
      sessionStore,
    });

    await expect(
      (
        agent as unknown as {
          refreshSessionRecap: (signal?: AbortSignal) => Promise<void>;
        }
      ).refreshSessionRecap(),
    ).resolves.toBeUndefined();

    expect(mocks.generateRecap).toHaveBeenCalled();
    expect(sessionStore.setRecap).toHaveBeenCalled();
  });

  it("skips recap generation when recaps are disabled", async () => {
    const { Agent, mocks } = await importAgentModuleWithRecapMocks();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    const session = {
      id: "session-1",
      workspaceId: "workspace-1",
      title: null,
      recap: null,
      model: "grok-4.3",
      mode: "agent",
      cwdAtStart: process.cwd(),
      cwdLast: process.cwd(),
      status: "active",
      createdAt: new Date("2026-04-22T15:00:00.000Z"),
      updatedAt: new Date("2026-04-22T15:00:00.000Z"),
    };
    const sessionStore = {
      setRecap: vi.fn(),
      getRequiredSession: vi.fn(() => session),
    };

    agent.setRecapsEnabled(false);
    Object.assign(agent as object, {
      provider: {},
      session,
      sessionStore,
    });

    await (
      agent as unknown as {
        refreshSessionRecap: (signal?: AbortSignal) => Promise<void>;
      }
    ).refreshSessionRecap();

    expect(mocks.generateRecap).not.toHaveBeenCalled();
    expect(sessionStore.setRecap).not.toHaveBeenCalled();
  });
});
