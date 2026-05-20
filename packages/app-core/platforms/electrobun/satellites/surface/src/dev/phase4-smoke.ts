import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentMessageStreamEvent } from "../protocol/event-types.ts";
import {
  RuntimeSatelliteClient,
  type RuntimeEventHandler,
  type RuntimeEventTailResult,
  type RuntimeSatelliteBridge,
} from "../protocol/runtime-client.ts";
import {
  addAssistantStreamMessage,
  addUserMessage,
  applyRuntimeEvent,
  createInitialState,
} from "../web/state.ts";

function runtimeSmokeResponse(method: string, params?: unknown): unknown {
  if (method === "runtime.status") {
    return {
      mode: "running",
      cwd: "/tmp/eliza",
      command: ["bun", "run", "dev"],
      apiBase: "http://127.0.0.1:31337",
      pid: 4242,
      startedAt: "2026-05-17T00:00:00.000Z",
      stoppedAt: null,
      error: null,
    };
  }
  if (method === "api.discover") {
    return {
      apiBase: "http://127.0.0.1:31337",
      routes: [
        {
          name: "status.devStack",
          method: "GET",
          path: "/api/dev/stack",
          available: true,
          status: 200,
        },
      ],
      streamingRoutes: [
        {
          name: "conversation.messageStream",
          method: "POST",
          path: "/api/conversations/:conversationId/messages/stream",
          available: true,
          status: 204,
        },
      ],
    };
  }
  if (method === "agent.list") {
    return [{ id: "agent-1", name: "Eliza", status: "ready" }];
  }
  if (method !== "agent.message.stream") return undefined;
  assert(isRecord(params), "stream params are object");
  assert(params.text === "hello", "stream params carry text");
  return {
    ok: true,
    streamId: "stream-1",
    conversationId: "conversation-1",
    messageId: "message-1",
  };
}

function fsSmokeResponse(method: string): unknown {
  if (method === "fs.roots") {
    return [{ id: "root-1", path: "/tmp/eliza", label: "eliza" }];
  }
  if (method === "fs.list") {
    return {
      root: { id: "root-1", path: "/tmp/eliza", label: "eliza" },
      path: "/tmp/eliza",
      entries: [
        {
          path: "/tmp/eliza/hello.txt",
          name: "hello.txt",
          kind: "file",
          size: 12,
          isText: true,
        },
      ],
    };
  }
  if (method === "fs.readText") {
    return {
      path: "/tmp/eliza/hello.txt",
      text: "hello file",
      size: 10,
      truncated: false,
    };
  }
  if (method !== "fs.search") return undefined;
  return {
    query: "hello",
    matches: [
      {
        path: "/tmp/eliza/hello.txt",
        line: 1,
        column: 1,
        preview: "hello file",
      },
    ],
  };
}

function ptySessionFixture(
  status: "running" | "killed",
  updatedAt: string,
): unknown {
  return {
    id: "pty-1",
    command: "/bin/zsh",
    args: [],
    cwd: "/tmp/eliza",
    status,
    pid: 4343,
    shell: "/bin/zsh",
    exitCode: null,
    signal: status === "killed" ? "SIGTERM" : null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt,
    ...(status === "killed" ? { exitedAt: updatedAt } : {}),
  };
}

function ptySmokeResponse(method: string): unknown {
  if (method === "pty.status") {
    return {
      id: "eliza.pty",
      ok: true,
      implementation: "bun-terminal",
      truePty: true,
      activeSessions: 1,
      totalSessions: 1,
      limits: {
        maxSessions: 8,
        maxOutputEntries: 5000,
        maxOutputBytes: 5242880,
        commandTimeoutMs: 120000,
      },
    };
  }
  if (method === "pty.session.create") {
    return {
      session: ptySessionFixture("running", "2026-05-17T00:00:00.000Z"),
    };
  }
  if (method === "pty.session.output.tail") {
    return {
      sessionId: "pty-1",
      entries: [
        {
          sessionId: "pty-1",
          sequence: 0,
          data: "pty smoke\n",
          timestamp: "2026-05-17T00:00:01.000Z",
        },
      ],
      nextSequence: 1,
    };
  }
  if (method === "pty.session.write") {
    return ptySessionFixture("running", "2026-05-17T00:00:02.000Z");
  }
  if (method !== "pty.session.kill") return undefined;
  return ptySessionFixture("killed", "2026-05-17T00:00:03.000Z");
}

function gitSmokeResponse(method: string): unknown {
  if (method === "git.repo.info") {
    return {
      cwd: "/tmp/eliza",
      root: "/tmp/eliza",
      isRepo: true,
      branch: "main",
      head: "abc123",
    };
  }
  if (method === "git.status") {
    return {
      repo: {
        cwd: "/tmp/eliza",
        root: "/tmp/eliza",
        isRepo: true,
        branch: "main",
      },
      branch: "main",
      files: [
        {
          path: "hello.txt",
          index: " ",
          workingTree: "M",
          raw: " M hello.txt",
        },
      ],
      raw: "## main\n M hello.txt\n",
    };
  }
  if (method === "git.branches") {
    return [{ name: "main", current: true, remote: false }];
  }
  if (method === "git.log") {
    return [{ hash: "abc123", shortHash: "abc123", subject: "initial commit" }];
  }
  if (method !== "git.operation.list") return undefined;
  return [
    {
      id: "git-1",
      name: "git.add",
      cwd: "/tmp/eliza",
      command: ["git", "add", "--", "hello.txt"],
      status: "completed",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      startedAt: "2026-05-17T00:00:00.000Z",
      completedAt: "2026-05-17T00:00:01.000Z",
    },
  ];
}

const modelCatalogEntry = {
  id: "eliza-1-2b",
  displayName: "Eliza-1 2B",
  provider: "eliza-1",
  family: "eliza-1",
  hfRepo: "elizaos/eliza-1",
  bundlePath: "bundles/2b",
  tier: "2b",
  roles: ["chat"],
  capabilities: ["text-generation"],
};

const modelTierEntry = {
  tier: "2b",
  bundlePath: "bundles/2b",
  displayName: "Eliza-1 2B",
  visibleOnHf: true,
  activeTier: true,
  roles: ["chat"],
  capabilities: ["text-generation"],
};

const modelVoiceEntry = {
  id: "omnivoice",
  path: "voice/omnivoice",
  displayName: "OmniVoice",
  roles: ["tts", "voice"],
  capabilities: ["text-to-speech"],
};

function modelSmokeResponse(method: string): unknown {
  if (method === "model.hub") {
    return {
      catalog: [modelCatalogEntry],
      eliza1Tiers: [modelTierEntry],
      voiceComponents: [modelVoiceEntry],
      installed: [],
      active: { modelId: null, status: "idle" },
      downloads: [],
      assignments: { TEXT_LARGE: "eliza-1-2b" },
      routing: { preferences: {} },
    };
  }
  if (method === "model.catalog.eliza1") return [modelCatalogEntry];
  if (method === "model.eliza1.tiers") return [modelTierEntry];
  if (method === "model.eliza1.voice") return [modelVoiceEntry];
  if (method === "model.active") return { modelId: null, status: "idle" };
  if (method === "model.downloads") return [];
  return undefined;
}

function mockInvokeResponse(method: string, params?: unknown): unknown {
  return (
    runtimeSmokeResponse(method, params) ??
    fsSmokeResponse(method) ??
    ptySmokeResponse(method) ??
    gitSmokeResponse(method) ??
    modelSmokeResponse(method)
  );
}

class MockRuntimeBridge implements RuntimeSatelliteBridge {
  private readonly handlers = new Map<string, Set<RuntimeEventHandler>>();

  async invoke(
    targetId: string,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    assert(targetId === "eliza.runtime", "client targets eliza.runtime");
    const response = mockInvokeResponse(method, params);
    if (response !== undefined) return response;
    throw new Error(`Unexpected method ${method}`);
  }

  on(eventName: string, handler: RuntimeEventHandler): () => void {
    const handlers = this.handlers.get(eventName) ?? new Set();
    handlers.add(handler);
    this.handlers.set(eventName, handlers);
    return () => handlers.delete(handler);
  }

  emit(eventName: string, payload: unknown): void {
    const handlers = this.handlers.get(eventName);
    if (!handlers) return;
    for (const handler of handlers) handler(payload);
  }
}

class TailRuntimeBridge extends MockRuntimeBridge {
  private delivered = false;

  async tailEvents(
    targetId: string,
    afterSequence?: number,
  ): Promise<RuntimeEventTailResult> {
    assert(targetId === "eliza.runtime", "event tail targets eliza.runtime");
    if (this.delivered) {
      return {
        id: targetId,
        events: [],
        nextSequence: afterSequence ?? 1,
      };
    }
    this.delivered = true;
    return {
      id: targetId,
      events: [
        {
          remotePluginId: targetId,
          satelliteId: targetId,
          sequence: 1,
          name: "agent.message.stream.delta",
          payload: {
            streamId: "stream-1",
            kind: "delta",
            conversationId: "conversation-1",
            messageId: "message-1",
            timestamp: "2026-05-17T00:00:04.000Z",
            delta: "tail",
          },
          timestamp: "2026-05-17T00:00:04.000Z",
        },
      ],
      nextSequence: 1,
    };
  }
}

const root = process.cwd();
for (const relativePath of [
  "package.json",
  "electrobun.config.ts",
  "plugin.json",
  "src/protocol/runtime-client.ts",
  "src/web/index.html",
]) {
  assert(
    existsSync(path.join(root, relativePath)),
    `expected ${relativePath} to exist`,
  );
}

const bridge = new MockRuntimeBridge();
const client = new RuntimeSatelliteClient({ bridge });
const state = createInitialState();

for (const eventName of [
  "agent.message.stream.started",
  "agent.message.stream.delta",
  "agent.message.stream.snapshot",
  "agent.message.stream.action",
  "agent.message.stream.done",
]) {
  client.on(eventName, (payload) =>
    applyRuntimeEvent(state, eventName, payload),
  );
}

state.runtimeState = await client.status();
assert(state.runtimeState.mode === "running", "runtime status is stored");

state.apiDiscovery = await client.discoverApi();
assert(
  state.apiDiscovery.streamingRoutes[0]?.path ===
    "/api/conversations/:conversationId/messages/stream",
  "stream route discovery is stored",
);

state.agents = await client.listAgents();
assert(state.agents[0]?.id === "agent-1", "agents are stored");

state.fileRoots = await client.fsRoots();
assert(state.fileRoots[0]?.id === "root-1", "file roots are stored");
state.fileList = await client.fsList({ path: "/tmp/eliza" });
assert(
  state.fileList.entries[0]?.name === "hello.txt",
  "file listing is stored",
);
state.fileText = await client.fsReadText({ path: "/tmp/eliza/hello.txt" });
assert(state.fileText.text === "hello file", "file text is stored");
state.fileSearch = await client.fsSearch({
  path: "/tmp/eliza",
  query: "hello",
});
assert(state.fileSearch.matches.length === 1, "file search matches are stored");

state.ptyStatus = await client.ptyStatus();
assert(state.ptyStatus.truePty === true, "terminal status is stored");
const ptySession = await client.ptyCreateSession({});
state.ptySessions = [ptySession.session];
state.activePtySessionId = ptySession.session.id;
const ptyTail = await client.ptyOutputTail({
  sessionId: ptySession.session.id,
});
state.ptyOutput = ptyTail.entries;
state.ptyNextSequence = ptyTail.nextSequence;
assert(
  state.ptyOutput[0]?.data.includes("pty smoke"),
  "terminal output is stored",
);
const writtenSession = await client.ptyWrite({
  sessionId: ptySession.session.id,
  data: "echo hi\n",
});
assert(writtenSession.status === "running", "terminal write uses runtime path");
const killedSession = await client.ptyKill({
  sessionId: ptySession.session.id,
});
assert(killedSession.status === "killed", "terminal kill uses runtime path");

state.gitRepo = await client.gitRepoInfo({ cwd: "/tmp/eliza" });
assert(state.gitRepo.branch === "main", "git repo info is stored");
state.gitStatus = await client.gitStatus({ cwd: "/tmp/eliza" });
state.gitRepoStatus = state.gitStatus;
assert(state.gitStatus.files[0]?.path === "hello.txt", "git status is stored");
state.gitBranches = await client.gitBranches({ cwd: "/tmp/eliza" });
assert(state.gitBranches[0]?.current === true, "git branches are stored");
state.gitLog = await client.gitLog({ cwd: "/tmp/eliza", limit: 5 });
assert(state.gitLog[0]?.subject === "initial commit", "git log is stored");
state.gitOperations = await client.gitOperationList(10);
assert(state.gitOperations[0]?.id === "git-1", "git operations are stored");

state.modelHub = await client.modelHub();
state.modelCatalog = await client.modelEliza1Catalog();
state.modelEliza1Tiers = await client.modelEliza1Tiers();
state.modelVoiceComponents = await client.modelEliza1Voice();
state.modelActive = await client.modelActive();
state.modelDownloads = await client.modelDownloads();
assert(
  state.modelHub.catalog[0]?.hfRepo === "elizaos/eliza-1",
  "model hub is stored",
);
assert(state.modelCatalog[0]?.id === "eliza-1-2b", "model catalog is stored");
assert(state.modelEliza1Tiers[0]?.tier === "2b", "Eliza-1 tiers are stored");
assert(
  state.modelVoiceComponents[0]?.id === "omnivoice",
  "voice components are stored",
);

addUserMessage(state, "hello");
const stream = await client.startMessageStream({
  agentId: "agent-1",
  conversationId: "conversation-1",
  text: "hello",
});
addAssistantStreamMessage(state, stream.streamId);

bridge.emit("agent.message.stream.started", streamEvent("started"));
bridge.emit(
  "agent.message.stream.delta",
  streamEvent("delta", { delta: "Hi" }),
);
bridge.emit(
  "agent.message.stream.delta",
  streamEvent("delta", { delta: " there" }),
);
bridge.emit(
  "agent.message.stream.snapshot",
  streamEvent("snapshot", { text: "tool callback snapshot" }),
);
bridge.emit(
  "agent.message.stream.action",
  streamEvent("action", {
    actionName: "searchMemory",
    payload: { query: "hello" },
  }),
);
bridge.emit("agent.message.stream.done", streamEvent("done"));

const tailBridge = new TailRuntimeBridge();
const tailClient = new RuntimeSatelliteClient({ bridge: tailBridge });
let tailedDelta = "";
const unsubscribeTail = tailClient.on(
  "agent.message.stream.delta",
  (payload) => {
    if (isRecord(payload) && typeof payload.delta === "string") {
      tailedDelta = payload.delta;
    }
  },
);
await new Promise((resolve) => setTimeout(resolve, 50));
unsubscribeTail();
assert(tailedDelta === "tail", "event tail delivers runtime events");

const assistant = state.chatMessages.find(
  (message) => message.role === "assistant" && message.streamId === "stream-1",
);
assert(assistant?.text === "Hi there", "assistant receives only deltas");
assert(assistant.status === "done", "done marks stream complete");
assert(
  state.actionTimeline.some((event) => event.kind === "snapshot"),
  "snapshot enters timeline",
);
assert(
  state.actionTimeline.some((event) => event.kind === "action"),
  "action enters timeline",
);
assert(state.activeStreamId === null, "done clears active stream");

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      runtimeMode: state.runtimeState.mode,
      agents: state.agents.length,
      fileRoots: state.fileRoots.length,
      fileMatches: state.fileSearch.matches.length,
      terminalOutput: state.ptyOutput.length,
      gitFiles: state.gitStatus.files.length,
      gitOperations: state.gitOperations.length,
      modelCatalog: state.modelCatalog.length,
      modelTiers: state.modelEliza1Tiers.length,
      modelVoice: state.modelVoiceComponents.length,
      assistantText: assistant.text,
      timelineEvents: state.actionTimeline.length,
    },
    null,
    2,
  )}\n`,
);

function streamEvent(
  kind: AgentMessageStreamEvent["kind"],
  overrides: Partial<AgentMessageStreamEvent> = {},
): AgentMessageStreamEvent {
  return {
    streamId: "stream-1",
    kind,
    conversationId: "conversation-1",
    messageId: "message-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
