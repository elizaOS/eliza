import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ActionEventPayload,
  type AgentRuntime,
  EventType,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { TUI, visibleWidth } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import { App } from "../../packages/examples/code/src/App.js";
import { ChatPane } from "../../packages/examples/code/src/components/ChatPane.js";
import { MainScreen } from "../../packages/examples/code/src/components/MainScreen.js";
import { StatusBar } from "../../packages/examples/code/src/components/StatusBar.js";
import { TaskPane } from "../../packages/examples/code/src/components/TaskPane.js";
import { setCwd } from "../../packages/examples/code/src/lib/cwd.js";
import { useStore } from "../../packages/examples/code/src/lib/store.js";
import { shellAction } from "../../plugins/plugin-coding-tools/src/actions/bash.js";
import { editFileHandler } from "../../plugins/plugin-coding-tools/src/actions/edit.js";
import {
  FileStateService,
  SandboxService,
  SessionCwdService,
} from "../../plugins/plugin-coding-tools/src/services/index.js";
import {
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../../plugins/plugin-coding-tools/src/types.js";

type RuntimeHandler = (payload: ActionEventPayload) => void | Promise<void>;

interface ToolCall {
  id: string;
  name: "FILE" | "SHELL";
  arguments: Record<string, unknown>;
}

interface ModelStep {
  label: string;
  request: {
    model: string;
    messages: Array<Record<string, unknown>>;
    toolChoice?: unknown;
  };
  response: Record<string, unknown>;
  toolCall?: ToolCall;
}

interface ActionRecord {
  action: "FILE" | "SHELL";
  startedLine: string;
  completedLine: string;
  success: boolean;
  data?: unknown;
  text?: string;
}

const evidenceDir = path.resolve(".github/issue-evidence");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: evidence harness runtime override, not a turbo task input.
const model = process.env.OPENAI_LARGE_MODEL ?? "gpt-oss-120b";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function makeRuntime(settings: Map<string, unknown>) {
  const handlers = new Map<string, RuntimeHandler[]>();
  const services = new Map<string, unknown>();
  const runtime = Object.assign(Object.create(null), {
    agentId: stringToUuid("11330-evidence-agent"),
    character: { name: "Eliza" },
    getSetting: (key: string) => settings.get(key),
    getService: <T>(key: string): T | null => (services.get(key) as T) ?? null,
    registerEvent: (event: string, handler: RuntimeHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }) as AgentRuntime & IAgentRuntime;

  const emit = async (event: EventType, payload: ActionEventPayload) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload);
    }
  };

  return { runtime, services, emit };
}

function actionPayload(args: {
  action: "FILE" | "SHELL";
  roomId: UUID;
  worldId: UUID;
  messageId: UUID;
  result?: { success: boolean; text?: string; data?: unknown; error?: unknown };
}): ActionEventPayload {
  return Object.assign(Object.create(null) as ActionEventPayload, {
    roomId: args.roomId,
    world: args.worldId,
    messageId: args.messageId,
    content: {
      text: args.result?.text ?? `Executing ${args.action}`,
      actions: [args.action],
      actionStatus: args.result
        ? args.result.success
          ? "completed"
          : "failed"
        : "executing",
      actionResult: args.result,
      source: "issue-11330-evidence",
    },
  });
}

function toolCallFromResponse(
  response: Record<string, unknown>,
  expected: "FILE" | "SHELL",
): ToolCall {
  const choices = response.choices as
    | Array<{ message?: { tool_calls?: Array<unknown> } }>
    | undefined;
  const rawCall = choices?.[0]?.message?.tool_calls?.[0] as
    | { id?: string; function?: { name?: string; arguments?: string } }
    | undefined;
  if (!rawCall?.function?.name) {
    throw new Error(`model did not return a ${expected} tool call`);
  }
  const name = rawCall.function.name;
  if (name !== expected) {
    throw new Error(`expected ${expected}, got ${name}`);
  }
  const args =
    rawCall.function.arguments && rawCall.function.arguments.length > 0
      ? JSON.parse(rawCall.function.arguments)
      : {};
  return {
    id: rawCall.id ?? `${expected.toLowerCase()}-call`,
    name,
    arguments: args,
  };
}

async function callModel(args: {
  label: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
}): Promise<{ step: ModelStep; toolCall?: ToolCall }> {
  const base = requireEnv("OPENAI_BASE_URL");
  const key = requireEnv("OPENAI_API_KEY");
  const url = new URL(
    "chat/completions",
    base.endsWith("/") ? base : `${base}/`,
  );
  const body = {
    model,
    messages: args.messages,
    ...(args.tools ? { tools: args.tools } : {}),
    ...(args.toolChoice ? { tool_choice: args.toolChoice } : {}),
    temperature: 0,
    max_tokens: 512,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const response = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `model call failed ${res.status}: ${JSON.stringify(response)}`,
    );
  }
  const step: ModelStep = {
    label: args.label,
    request: {
      model,
      messages: args.messages,
      toolChoice: args.toolChoice,
    },
    response,
  };
  return { step };
}

function codingTools(filePath: string, cwd: string) {
  return [
    {
      type: "function",
      function: {
        name: "FILE",
        description: "Edit a workspace file.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["edit"] },
            file_path: { type: "string", const: filePath },
            old_string: { type: "string", const: "before" },
            new_string: { type: "string" },
          },
          required: ["action", "file_path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "SHELL",
        description: "Run a shell command in the workspace.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["run"] },
            command: { type: "string", const: "cat live-tool-fixture.txt" },
            cwd: { type: "string", const: cwd },
          },
          required: ["action", "command", "cwd"],
        },
      },
    },
  ];
}

function renderTranscript(runtime: AgentRuntime) {
  const terminal = new VirtualTerminal(80, 24);
  const tui = new TUI(terminal);
  const chatPane = new ChatPane({ onSubmit: async () => {}, tui });
  chatPane.syncFocus(true);
  const statusBar = new StatusBar();
  const taskPane = new TaskPane({ runtime, tui });
  const mainScreen = new MainScreen(terminal, statusBar, chatPane, taskPane);
  const lines = mainScreen.render(80);
  const widest = Math.max(...lines.map(visibleWidth));
  if (widest > 80) throw new Error(`render overflowed: ${widest}`);
  return lines.join("\n");
}

function stripAnsi(input: string): string {
  const escapeChar = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  let output = "";
  let index = 0;

  while (index < input.length) {
    if (input[index] !== escapeChar) {
      output += input[index];
      index += 1;
      continue;
    }

    const next = input[index + 1];
    if (next === "]") {
      index += 2;
      while (
        index < input.length &&
        input[index] !== bell &&
        !(input[index] === escapeChar && input[index + 1] === "\\")
      ) {
        index += 1;
      }
      index += input[index] === escapeChar ? 2 : 1;
      continue;
    }

    if (next === "[") {
      index += 2;
      while (index < input.length) {
        const code = input.charCodeAt(index);
        index += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }

    index += 1;
  }

  return output;
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const tmpDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "issue-11330-evidence-")),
  );
  const filePath = path.join(tmpDir, "live-tool-fixture.txt");
  await fs.writeFile(filePath, "alpha\nbefore\nomega\n", "utf8");
  const realFilePath = await fs.realpath(filePath);

  const settings = new Map<string, unknown>([
    ["CODING_TOOLS_WORKSPACE_ROOTS", tmpDir],
    ["CODING_TOOLS_SHELL_TIMEOUT_MS", 60000],
  ]);
  const { runtime, services, emit } = makeRuntime(settings);
  const sandbox = await SandboxService.start(runtime);
  const fileState = await FileStateService.start(runtime);
  const sessionCwd = await SessionCwdService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(FILE_STATE_SERVICE, fileState);
  services.set(SESSION_CWD_SERVICE, sessionCwd);

  const trajectory: ModelStep[] = [];
  const actionRecords: ActionRecord[] = [];

  try {
    setCwd(tmpDir);
    useStore.setState({
      rooms: [],
      tasks: [],
      currentTaskId: null,
      inputValue: "",
      isLoading: false,
      isAgentTyping: false,
      focusedPane: "chat",
      taskPaneVisibility: "hidden",
    });
    const state = useStore.getState();
    const room = state.createRoom("Issue 11330 live model evidence");
    state.addMessage(
      room.id,
      "user",
      "Edit live-tool-fixture.txt, then run cat live-tool-fixture.txt.",
    );

    const app = new App(runtime);
    // biome-ignore lint/complexity/useLiteralKeys: evidence harness uses the same private setup as the unit test.
    app["initializeManagers"]();

    const messageId = stringToUuid("11330-evidence-message");
    const message = {
      id: messageId,
      roomId: room.elizaRoomId,
      entityId: state.identity.userId,
      agentId: runtime.agentId as UUID,
      content: {
        text: "Edit live-tool-fixture.txt, then run cat live-tool-fixture.txt.",
        source: "issue-11330-evidence",
      },
      createdAt: Date.now(),
    } as Memory;

    const tools = codingTools(realFilePath, tmpDir);
    const commonSystem = {
      role: "system",
      content:
        "You are driving real tools for evidence. Return the requested tool call only.",
    };

    const fileModel = await callModel({
      label: "live-model-file-tool-call",
      messages: [
        commonSystem,
        {
          role: "user",
          content: `Call FILE to edit ${realFilePath}: replace before with exactly after-one\\nafter-two.`,
        },
      ],
      tools,
      toolChoice: { type: "function", function: { name: "FILE" } },
    });
    const fileCall = toolCallFromResponse(fileModel.step.response, "FILE");
    fileModel.step.toolCall = fileCall;
    trajectory.push(fileModel.step);

    await fileState.recordRead(String(room.elizaRoomId), realFilePath);
    await emit(
      EventType.ACTION_STARTED,
      actionPayload({
        action: "FILE",
        roomId: room.elizaRoomId,
        worldId: state.identity.worldId,
        messageId,
      }),
    );
    const editResult = await editFileHandler(runtime, message, undefined, {
      parameters: fileCall.arguments,
    });
    await emit(
      EventType.ACTION_COMPLETED,
      actionPayload({
        action: "FILE",
        roomId: room.elizaRoomId,
        worldId: state.identity.worldId,
        messageId,
        result: editResult,
      }),
    );
    actionRecords.push({
      action: "FILE",
      startedLine: "tool file",
      completedLine: "edit live-tool-fixture.txt +2/-1",
      success: editResult.success,
      data: editResult.data,
      text: editResult.text,
    });

    const shellModel = await callModel({
      label: "live-model-shell-tool-call",
      messages: [
        commonSystem,
        {
          role: "user",
          content: `Call SHELL to run cat live-tool-fixture.txt in ${tmpDir}.`,
        },
      ],
      tools,
      toolChoice: { type: "function", function: { name: "SHELL" } },
    });
    const shellCall = toolCallFromResponse(shellModel.step.response, "SHELL");
    shellModel.step.toolCall = shellCall;
    trajectory.push(shellModel.step);

    await emit(
      EventType.ACTION_STARTED,
      actionPayload({
        action: "SHELL",
        roomId: room.elizaRoomId,
        worldId: state.identity.worldId,
        messageId,
      }),
    );
    const shellResult = await shellAction.handler?.(
      runtime,
      message,
      undefined,
      shellCall.arguments,
    );
    if (!shellResult) throw new Error("SHELL handler missing");
    await emit(
      EventType.ACTION_COMPLETED,
      actionPayload({
        action: "SHELL",
        roomId: room.elizaRoomId,
        worldId: state.identity.worldId,
        messageId,
        result: shellResult,
      }),
    );
    actionRecords.push({
      action: "SHELL",
      startedLine: "tool shell",
      completedLine: "run cat live-tool-fixture.txt exited 0",
      success: shellResult.success,
      data: shellResult.data,
      text: shellResult.text,
    });

    const finalModel = await callModel({
      label: "live-model-final-reply",
      messages: [
        commonSystem,
        {
          role: "user",
          content: "The edit and cat command succeeded. Reply done.",
        },
      ],
    });
    trajectory.push(finalModel.step);
    const finalMessage =
      (
        finalModel.step.response.choices as
          | Array<{ message?: { content?: string } }>
          | undefined
      )?.[0]?.message?.content?.trim() || "done";
    state.addMessage(room.id, "assistant", finalMessage);

    const rawRender = renderTranscript(runtime);
    const cleanRender = stripAnsi(rawRender);
    const finalFile = await fs.readFile(realFilePath, "utf8");

    await fs.writeFile(
      path.join(evidenceDir, "11330-live-model-trajectory.json"),
      `${JSON.stringify(
        {
          model,
          workspace: tmpDir,
          filePath: realFilePath,
          trajectory,
          actionRecords,
          finalFile,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "11330-live-tui-render.ansi"),
      `${rawRender}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "11330-live-tui-render.txt"),
      `${cleanRender}\n`,
      "utf8",
    );

    console.log(cleanRender);
    console.log("\n--- final file ---");
    console.log(finalFile);
  } finally {
    await sessionCwd.stop();
    await fileState.stop();
    await sandbox.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
