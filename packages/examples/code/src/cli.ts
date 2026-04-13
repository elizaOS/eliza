#!/usr/bin/env node
/**
 * Non-interactive CLI mode for Eliza Code
 *
 * Usage:
 *   eliza-code --help                    Show help
 *   eliza-code --version                 Show version
 *   eliza-code "message"                 Send a message and get response
 *   eliza-code --file <path>             Read message from file
 *   echo "message" | eliza-code          Read message from stdin
 *   eliza-code --json "message"          Output response as JSON
 *   eliza-code --stream "message"        Stream response as it's generated
 */

import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { v4 as uuidv4 } from "uuid";
import { initializeAgent, shutdownAgent } from "./lib/agent.js";
import { getAgentClient } from "./lib/agent-client.js";
import { getCwd, setCwd } from "./lib/cwd.js";
import { ensureSessionIdentity, getMainRoomElizaId } from "./lib/identity.js";
import { loadEnv } from "./lib/load-env.js";
import { resolveModelProvider } from "./lib/model-provider.js";
import { loadSession, type SessionState, saveSession } from "./lib/session.js";
import type { ChatRoom, Message, MessageRole } from "./types.js";

// ============================================================================
// Types
// ============================================================================

interface CLIOptions {
  help: boolean;
  version: boolean;
  json: boolean;
  stream: boolean;
  file: string | null;
  cwd: string | null;
  message: string | null;
  interactive: boolean;
}

interface CLIResult {
  success: boolean;
  response?: string;
  error?: string;
  timing?: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const VERSION = "1.0.0";

const HELP_TEXT = `
Eliza Code - Async Coding Agent CLI

Usage:
  eliza-code [options] [message]

Options:
  -h, --help              Show this help message
  -v, --version           Show version number
  -j, --json              Output response as JSON
  -s, --stream            Stream response as it's generated
  -f, --file <path>       Read message from file
  -c, --cwd <path>        Set working directory
  -i, --interactive       Force interactive mode (TUI)

Examples:
  eliza-code "What files are in the current directory?"
  eliza-code --json "Review the code in src/index.ts"
  eliza-code --file prompt.txt
  eliza-code --cwd /path/to/project "Run the tests"
  echo "Explain this code" | eliza-code

Environment Variables:
  OPENAI_API_KEY          Required (if using OpenAI). Your OpenAI API key
  ANTHROPIC_API_KEY       Required (if using Anthropic). Your Anthropic API key
  ELIZA_CODE_PROVIDER     Optional. Force provider: openai|anthropic
  LOG_LEVEL               Log level (default: fatal for CLI)
`;

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = {
    help: false,
    version: false,
    json: false,
    stream: false,
    file: null,
    cwd: null,
    message: null,
    interactive: false,
  };

  let i = 0;
  const positionalArgs: string[] = [];

  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;

      case "-v":
      case "--version":
        options.version = true;
        break;

      case "-j":
      case "--json":
        options.json = true;
        break;

      case "-s":
      case "--stream":
        options.stream = true;
        break;

      case "-i":
      case "--interactive":
        options.interactive = true;
        break;

      case "-f":
      case "--file":
        i++;
        if (i >= args.length) {
          throw new Error("--file requires a path argument");
        }
        options.file = args[i];
        break;

      case "-c":
      case "--cwd":
        i++;
        if (i >= args.length) {
          throw new Error("--cwd requires a path argument");
        }
        options.cwd = args[i];
        break;

      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positionalArgs.push(arg);
        break;
    }

    i++;
  }

  // Join positional args as the message
  if (positionalArgs.length > 0) {
    options.message = positionalArgs.join(" ");
  }

  return options;
}

// ============================================================================
// Input Handling
// ============================================================================

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on("line", (line) => {
      data += `${line}\n`;
    });

    rl.on("close", () => {
      resolve(data.trim());
    });

    rl.on("error", reject);

    // Timeout after 100ms if no data (means no piped input)
    setTimeout(() => {
      if (data === "") {
        rl.close();
      }
    }, 100);
  });
}

async function getMessage(options: CLIOptions): Promise<string | null> {
  // Message from arguments
  if (options.message) {
    return options.message;
  }

  // Message from file
  if (options.file) {
    const content = await fs.readFile(options.file, "utf-8");
    return content.trim();
  }

  // Message from stdin (only if not a TTY)
  if (!process.stdin.isTTY) {
    const stdinContent = await readStdin();
    if (stdinContent) {
      return stdinContent;
    }
  }

  return null;
}

function createDefaultSessionState(): SessionState {
  const identity = ensureSessionIdentity();
  const room: ChatRoom = {
    id: "default-main-room",
    name: "Main",
    messages: [],
    createdAt: new Date(),
    taskIds: [],
    elizaRoomId: getMainRoomElizaId(identity),
  };

  return {
    rooms: [room],
    currentRoomId: room.id,
    currentTaskId: null,
    cwd: getCwd(),
    identity,
  };
}

function getCurrentRoomFromSession(session: SessionState): ChatRoom {
  const byId = session.rooms.find((r) => r.id === session.currentRoomId);
  if (byId) return byId;
  const fallback = session.rooms[0];
  if (!fallback) {
    // Should never happen (we always create at least one room).
    throw new Error("Session has no rooms");
  }
  session.currentRoomId = fallback.id;
  return fallback;
}

function appendSessionMessage(
  session: SessionState,
  room: ChatRoom,
  role: MessageRole,
  content: string,
): void {
  const message: Message = {
    id: uuidv4(),
    role,
    content,
    timestamp: new Date(),
    roomId: room.id,
  };

  // Mutate in place (session is not shared across callers).
  room.messages.push(message);

  // Ensure the room in the session references the updated messages array.
  session.rooms = session.rooms.map((r) => (r.id === room.id ? room : r));
}

// ============================================================================
// CLI Execution
// ============================================================================

async function runCLI(options: CLIOptions): Promise<CLIResult> {
  const startedAt = Date.now();

  // Set working directory if specified
  if (options.cwd) {
    const result = await setCwd(options.cwd);
    if (!result.success) {
      return {
        success: false,
        error: `Failed to set working directory: ${result.error}`,
      };
    }
    // In CLI mode, treat --cwd as the project root for session persistence.
    process.chdir(result.path);
  }

  // Get message
  const message = await getMessage(options);
  if (!message) {
    return {
      success: false,
      error: "No message provided. Use --help for usage information.",
    };
  }

  // Initialize agent
  let runtime: Awaited<ReturnType<typeof initializeAgent>> | undefined;

  try {
    runtime = await initializeAgent();

    const agentClient = getAgentClient();
    agentClient.setRuntime(runtime);

    const session = (await loadSession()) ?? createDefaultSessionState();
    const room = getCurrentRoomFromSession(session);

    appendSessionMessage(session, room, "user", message);

    const shouldStream = options.stream && !options.json;
    let didPrintStreaming = false;

    // Send message and get response
    const response = await agentClient.sendMessage({
      room,
      text: message,
      identity: session.identity,
      onDelta: shouldStream
        ? (delta) => {
            // Write deltas directly for real-time streaming.
            process.stdout.write(delta);
            didPrintStreaming = true;
          }
        : undefined,
    });

    if (didPrintStreaming) {
      process.stdout.write("\n");
    }

    appendSessionMessage(session, room, "assistant", response);

    // Update session CWD and persist best-effort (so TUI + CLI share history).
    session.cwd = getCwd();
    try {
      await saveSession(session);
    } catch {
      // Ignore session save errors in CLI mode
    }

    const completedAt = Date.now();

    return {
      success: true,
      response,
      timing: {
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      },
    };
  } finally {
    if (runtime) {
      await shutdownAgent(runtime);
    }
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatOutput(result: CLIResult, options: CLIOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    console.log(result.response);
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function main(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  loadEnv();

  // Suppress logs in CLI mode
  process.env.LOG_LEVEL = "fatal";

  const options = parseArgs(args);

  // Handle help
  if (options.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  // Handle version
  if (options.version) {
    console.log(`eliza-code v${VERSION}`);
    return 0;
  }

  // If interactive mode is requested, return special code to indicate TUI should run
  if (options.interactive) {
    return -1; // Special code: run TUI
  }

  // Check for API key
  try {
    const provider = resolveModelProvider(process.env);
    if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY?.trim()) {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is required (ELIZA_CODE_PROVIDER=anthropic)",
      );
      console.error("Set it in your environment or in a .env file");
      return 1;
    }
    if (provider === "openai" && !process.env.OPENAI_API_KEY?.trim()) {
      console.error(
        "Error: OPENAI_API_KEY environment variable is required (ELIZA_CODE_PROVIDER=openai)",
      );
      console.error("Set it in your environment or in a .env file");
      return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  }

  // Run CLI
  const result = await runCLI(options);
  formatOutput(result, options);

  return result.success ? 0 : 1;
}

// ============================================================================
// Exports for Testing
// ============================================================================

export {
  parseArgs,
  getMessage,
  runCLI,
  formatOutput,
  type CLIOptions,
  type CLIResult,
};
