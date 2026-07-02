// Evidence capture for PR (#11294 batch): drives the REAL App handlers against
// a deferred-turn runtime stub (same harness as src/turn-queue.test.ts) and
// renders the REAL MainScreen through @elizaos/tui's VirtualTerminal.
// Run: bun evidence-frames.ts   (from packages/examples/code)
import { stripVTControlCharacters } from "node:util";
import type { AgentRuntime } from "@elizaos/core";
import { TUI } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import { App } from "./src/App.js";
import { ChatPane } from "./src/components/ChatPane.js";
import { MainScreen } from "./src/components/MainScreen.js";
import { StatusBar } from "./src/components/StatusBar.js";
import { TaskPane } from "./src/components/TaskPane.js";
import { getAgentClient } from "./src/lib/agent-client.js";
import { useStore } from "./src/lib/store.js";

process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE = "1";

const COLS = 80;

function makeScreen() {
  const terminal = new VirtualTerminal(COLS, 26);
  const tui = new TUI(terminal);
  const chatPane = new ChatPane({ onSubmit: async () => {}, tui });
  chatPane.syncFocus(true);
  const screen = new MainScreen(
    terminal,
    new StatusBar(),
    chatPane,
    new TaskPane({ runtime: {} as unknown as AgentRuntime, tui }),
  );
  return { screen, chatPane };
}

function printFrame(title: string, lines: string[]) {
  console.log(`\n===== ${title} =====`);
  for (const line of lines) {
    console.log(`|${stripVTControlCharacters(line)}`);
  }
}

interface DeferredTurn {
  resolve: () => void;
}

function makeApp() {
  const turns: DeferredTurn[] = [];
  const runtime = Object.assign(Object.create(null) as AgentRuntime, {
    agentId: "evidence",
    character: { name: "Eliza" },
    getService: () => null,
    ensureConnection: async () => {},
    messageService: {
      handleMessage: async (
        _rt: unknown,
        message: { content?: { text?: string } },
        callback: (content: { text: string }) => Promise<unknown>,
        options?: { abortSignal?: AbortSignal },
      ) => {
        await new Promise<void>((resolve, reject) => {
          turns.push({ resolve });
          options?.abortSignal?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
        await callback({
          text: `Done. Here's the summary for **${message.content?.text}**.`,
        });
        return { didRespond: true, responseMessages: [] };
      },
    },
  });
  getAgentClient().setRuntime(runtime);
  const app = new App(runtime);
  return {
    // biome-ignore lint/complexity/useLiteralKeys: private hook
    send: (text: string): Promise<void> => app["handleSendMessage"](text),
    // biome-ignore lint/complexity/useLiteralKeys: private hook
    consume: (data: string): boolean => app["consumeGlobalInput"](data),
    turns,
  };
}

async function waitFor(cond: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

useStore.setState({
  focusedPane: "chat",
  inputValue: "",
  rooms: [],
  pendingSubmissions: [],
  isLoading: false,
  isAgentTyping: false,
});

const { screen, chatPane } = makeScreen();
const { send, consume, turns } = makeApp();
useStore.getState().createRoom("Demo");

// --- Frame 1: turn running, second submission queued -----------------------
const turnA = send("refactor the session store");
await waitFor(() => turns.length === 1);
await send("also add tests for the edge cases please");
printFrame(
  "Frame 1 — Enter during a running turn queues the message (loading row shows the count)",
  screen.render(COLS),
);

// --- Frame 2: type-ahead composer stays visible mid-turn --------------------
for (const ch of "and update the README") chatPane.handleInput(ch);
printFrame(
  "Frame 2 — typing ahead mid-turn keeps the composer visible (footer: Enter queues)",
  screen.render(COLS),
);
for (let i = 0; i < "and update the README".length; i++)
  chatPane.handleInput("\x7f");

// --- Frame 3: abort discards the queue --------------------------------------
consume("\x03"); // first Ctrl+C: abort
await turnA;
printFrame(
  "Frame 3 — Esc/Ctrl+C aborts the turn and discards the queued message",
  screen.render(COLS),
);

// --- Frame 4: queued message drains on normal completion --------------------
useStore.setState({ rooms: [], pendingSubmissions: [] });
useStore.getState().createRoom("Demo 2");
const turnB = send("first task");
await waitFor(() => turns.length === 2);
await send("second task, queued");
turns[1]?.resolve();
await turnB;
await waitFor(() => turns.length === 3);
turns[2]?.resolve();
await waitFor(() => !useStore.getState().isLoading);
printFrame(
  "Frame 4 — queued submission fires as its own turn after the first completes (markdown-rendered replies)",
  screen.render(COLS),
);

process.exit(0);
