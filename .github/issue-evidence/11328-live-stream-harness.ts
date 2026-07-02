import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

setEnv("ELIZA_CODE_DISABLE_SESSION_PERSISTENCE", "1");
setEnv("ELIZA_CODE_PROVIDER", "openai");
setEnv("LOG_LEVEL", getEnv("LOG_LEVEL") ?? "fatal");

const openAiCompatibleKey =
  getEnv("OPENAI_API_KEY")?.trim() || getEnv("CEREBRAS_API_KEY")?.trim();
if (!openAiCompatibleKey) {
  throw new Error("Set OPENAI_API_KEY or CEREBRAS_API_KEY for live evidence.");
}

setEnv("OPENAI_API_KEY", openAiCompatibleKey);
const baseUrl =
  getEnv("OPENAI_BASE_URL") ||
  getEnv("CEREBRAS_BASE_URL") ||
  "https://api.cerebras.ai/v1";
setEnv("OPENAI_BASE_URL", baseUrl);
const model = getEnv("CEREBRAS_MODEL") || "gemma-4-31b";
setEnv("OPENAI_SMALL_MODEL", getEnv("OPENAI_SMALL_MODEL") || model);
setEnv("OPENAI_MEDIUM_MODEL", getEnv("OPENAI_MEDIUM_MODEL") || model);
setEnv("OPENAI_LARGE_MODEL", getEnv("OPENAI_LARGE_MODEL") || model);

const evidenceDir = path.dirname(fileURLToPath(import.meta.url));
await mkdir(evidenceDir, { recursive: true });

const [
  { AgentRuntime, ModelType },
  { getAgentClient, resetAgentClient },
  { useStore },
  { ChatPane },
  { CODE_ASSISTANT_SYSTEM_PROMPT },
  { plugin: sqlPlugin },
  { default: shellPlugin },
  { default: codingToolsPlugin },
  { TUI },
  { VirtualTerminal },
] = await Promise.all([
  import("@elizaos/core"),
  import("../../packages/examples/code/src/lib/agent-client.js"),
  import("../../packages/examples/code/src/lib/store.js"),
  import("../../packages/examples/code/src/components/ChatPane.js"),
  import("../../packages/examples/code/src/lib/prompts.js"),
  import("../../plugins/plugin-sql/src/dist/node/index.node.js"),
  import("../../plugins/plugin-shell/dist/index.js"),
  import("../../plugins/plugin-coding-tools/dist/index.js"),
  import("@elizaos/tui"),
  import("@elizaos/tui/testing"),
]);

interface StreamParams {
  onStreamChunk?: (chunk: string) => void | Promise<void>;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== "\u001b") {
      output += char;
      continue;
    }

    const next = value[index + 1];
    if (next === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index++;
      }
      continue;
    }

    if (next === "]") {
      index += 2;
      while (index < value.length) {
        if (value[index] === "\u0007") break;
        if (value[index] === "\u001b" && value[index + 1] === "\\") {
          index++;
          break;
        }
        index++;
      }
    }
  }
  return output;
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function readChoiceDelta(value: unknown): string {
  if (!isRecord(value)) return "";
  const choices = value.choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!isRecord(first)) return "";
  const delta = first.delta;
  if (!isRecord(delta)) return "";
  return typeof delta.content === "string" ? delta.content : "";
}

async function streamLiveModelText(
  onTextChunk: (chunk: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiCompatibleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content:
              "You are generating terminal streaming evidence. Reply in plain text only.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Live model request failed ${response.status}: ${await response.text()}`,
    );
  }
  if (!response.body) {
    throw new Error("Live model response did not include a stream body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const text = readChoiceDelta(JSON.parse(data));
        if (!text) continue;
        fullText += text;
        await onTextChunk(text);
      } catch {
        // Ignore malformed SSE keepalive/debug lines; the final stream text is
        // proven by the non-empty chunks we do parse.
      }
    }
  }

  return fullText;
}

function assistantContent(roomId: string, messageId: string): string {
  const room = useStore.getState().rooms.find((candidate) => {
    return candidate.id === roomId;
  });
  const message = room?.messages.find((candidate) => {
    return candidate.id === messageId;
  });
  return message?.content ?? "";
}

const prompt =
  "Do not call tools. Reply in plain text with eight numbered sentences about terminal streaming. Keep each sentence short and include the phrase live delta in every sentence.";

const liveStreamingModelPlugin = {
  name: "eliza-local-inference",
  models: {
    [ModelType.RESPONSE_HANDLER]: async (
      _runtime: unknown,
      params: Record<string, unknown>,
    ) => {
      const streamParams = params as StreamParams;
      await streamParams.onStreamChunk?.(
        '{"shouldRespond":"RESPOND","contexts":["simple"],"intents":[],"replyText":"',
      );
      const replyText = await streamLiveModelText(async (chunk) => {
        await streamParams.onStreamChunk?.(jsonStringContent(chunk));
      }, streamParams.signal);
      await streamParams.onStreamChunk?.('","facts":[]}');
      return JSON.stringify({
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        intents: [],
        replyText,
        facts: [],
      });
    },
  },
};

const terminal = new VirtualTerminal(80, 24);
const tui = new TUI(terminal);
const chatPane = new ChatPane({ onSubmit: async () => {}, tui });
chatPane.syncFocus(true);

resetAgentClient();
if (!getEnv("CODING_TOOLS_WORKSPACE_ROOTS")) {
  setEnv("CODING_TOOLS_WORKSPACE_ROOTS", process.cwd());
}
if (!getEnv("SHELL_ALLOWED_DIRECTORY")) {
  setEnv("SHELL_ALLOWED_DIRECTORY", process.cwd());
}

const runtime = new AgentRuntime({
  character: {
    name: "Eliza",
    bio: [
      "A coding assistant that directly helps users with implementation tasks.",
      "Capable of reading, writing, and editing files directly.",
      "Executes shell commands to run tests, linters, and other tools.",
    ],
    system: `${CODE_ASSISTANT_SYSTEM_PROMPT}

You are a direct coding agent. You have tools to READ, WRITE, and EDIT files directly.
You also have tools to execute SHELL commands.
When the user asks for code changes, CALL the provided tools to implement them
immediately - do NOT just describe what you would do. Take the action: emit the
tool call (FILE/WRITE/EDIT/SHELL), don't narrate "I'll create the file" and stop.
You do NOT need to create sub-agents or delegate tasks. You are the worker.
After making changes, verify them if possible (e.g. run a test), then give a one
line summary of what you did.
The current working directory is dynamically provided.`,
    topics: [
      "coding",
      "programming",
      "software development",
      "debugging",
      "testing",
      "refactoring",
      "file operations",
      "shell commands",
      "git",
      "TypeScript",
      "JavaScript",
      "Python",
      "Rust",
    ],
    style: {
      all: [
        "Be thorough but concise",
        "Explain your reasoning and actions",
        "Proactively identify potential issues",
        "Use code blocks for all code examples",
      ],
      chat: [
        "Engage naturally in conversation",
        "Provide updates on actions taken",
      ],
    },
    settings: {
      secrets: {},
    },
  },
  plugins: [
    sqlPlugin,
    liveStreamingModelPlugin,
    shellPlugin,
    codingToolsPlugin,
  ],
});
await runtime.initialize();
getAgentClient().setRuntime(runtime);

const startedAt = Date.now();
const deltas: Array<{
  index: number;
  atMs: number;
  chars: number;
  delta: string;
}> = [];
const renderSnapshots: Array<{
  label: string;
  atMs: number;
  assistantChars: number;
  plain: string[];
  raw: string[];
}> = [];

try {
  const room = useStore
    .getState()
    .createRoom("Issue 11328 live streaming evidence");
  useStore.getState().setLoading(true);
  useStore.getState().setAgentTyping(true);
  useStore.getState().addMessage(room.id, "user", prompt);
  const placeholder = useStore.getState().addMessage(room.id, "assistant", "");

  const capture = (label: string): void => {
    const raw = chatPane.renderContent(80, 24);
    renderSnapshots.push({
      label,
      atMs: Date.now() - startedAt,
      assistantChars: assistantContent(room.id, placeholder.id).length,
      plain: raw.map(stripAnsi),
      raw,
    });
  };

  capture("before-live-deltas-loader-visible");

  const response = await getAgentClient().sendMessage({
    room,
    text: prompt,
    identity: useStore.getState().identity,
    source: "eliza-code-evidence-11328",
    onDelta: (delta) => {
      const index = deltas.length + 1;
      deltas.push({
        index,
        atMs: Date.now() - startedAt,
        chars: delta.length,
        delta,
      });
      useStore.getState().appendToMessage(room.id, placeholder.id, delta);
      if (index <= 12) {
        capture(`delta-${index}`);
      }
    },
  });

  useStore.getState().setMessageContent(room.id, placeholder.id, response);
  useStore.getState().setLoading(false);
  useStore.getState().setAgentTyping(false);
  capture("final-response");

  const artifact = {
    issue: 11328,
    capturedAt: new Date(startedAt).toISOString(),
    provider: "openai-compatible",
    baseUrl,
    model,
    runtimePath:
      "AgentClient.sendMessage -> runtime.messageService.handleMessage -> core streaming context -> local evidence model -> live Cerebras SSE replyText chunks",
    streamWrapper:
      "The evidence-only local model wraps live Cerebras SSE text into the response-handler JSON replyText field so core's structured stream extractor and AgentClient onDelta path receive incremental visible text.",
    prompt,
    response,
    deltaCount: deltas.length,
    deltas,
    renderSnapshots,
  };

  const jsonPath = path.join(evidenceDir, "11328-live-stream.json");
  const textPath = path.join(evidenceDir, "11328-live-render.txt");
  const ansiPath = path.join(evidenceDir, "11328-live-render.ansi");

  await Bun.write(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await Bun.write(
    textPath,
    renderSnapshots
      .map((snapshot) => {
        return [
          `# ${snapshot.label} at ${snapshot.atMs}ms (${snapshot.assistantChars} assistant chars)`,
          ...snapshot.plain,
          "",
        ].join("\n");
      })
      .join("\n"),
  );
  await Bun.write(
    ansiPath,
    renderSnapshots
      .map((snapshot) => {
        return [
          `# ${snapshot.label} at ${snapshot.atMs}ms (${snapshot.assistantChars} assistant chars)`,
          ...snapshot.raw,
          "",
        ].join("\n");
      })
      .join("\n"),
  );

  if (deltas.length < 2) {
    throw new Error(
      `Expected multiple live stream deltas, got ${deltas.length}.`,
    );
  }

  console.log(
    `Captured ${deltas.length} live deltas and ${renderSnapshots.length} TUI snapshots.`,
  );
  console.log(`JSON: ${jsonPath}`);
  console.log(`Text: ${textPath}`);
  console.log(`ANSI: ${ansiPath}`);
} finally {
  chatPane.dispose();
  tui.stop();
  await runtime.stop();
}

process.exit(0);
