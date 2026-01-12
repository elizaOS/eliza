/**
 * Autonomous Self-Looping Agent
 *
 * A sandboxed, self-looping autonomous agent that:
 * - Thinks locally using plugin-local-ai with a small GGUF model
 * - Acts by running commands via plugin-shell (strictly inside a sandbox directory)
 * - Remembers via plugin-inmemorydb (ephemeral, in-process memory)
 *
 * The agent runs a continuous loop: plan → act → observe → store → repeat
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  type IDatabaseAdapter,
  logger,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { localAiPlugin } from "@elizaos/plugin-local-ai";
import { plugin as inMemoryPlugin, MemoryStorage } from "@elizaos/plugin-inmemorydb";
import { shellPlugin, ShellService } from "@elizaos/plugin-shell";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Configuration
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AutonomousConfig {
  sandboxDir: string;
  loopIntervalMs: number;
  maxIterations: number;
  maxConsecutiveFailures: number;
  stopOnFile: string;
  conversationId: string;
  agentId: UUID;
  memoryContextSize: number;
}

function loadConfig(): AutonomousConfig {
  const sandboxDir = process.env.SANDBOX_DIR || path.resolve(__dirname, "../sandbox");
  const agentIdRaw = process.env.AGENT_ID || uuidv4();

  return {
    sandboxDir,
    loopIntervalMs: Number.parseInt(process.env.LOOP_INTERVAL_MS || "3000", 10),
    maxIterations: Number.parseInt(process.env.MAX_ITERATIONS || "1000", 10),
    maxConsecutiveFailures: Number.parseInt(process.env.MAX_CONSECUTIVE_FAILURES || "5", 10),
    stopOnFile: path.join(sandboxDir, "STOP"),
    conversationId: process.env.CONVERSATION_ID || uuidv4(),
    agentId: agentIdRaw as UUID,
    memoryContextSize: Number.parseInt(process.env.MEMORY_CONTEXT_SIZE || "10", 10),
  };
}

// ============================================================================
// Types
// ============================================================================

type ActionType = "RUN" | "SLEEP" | "STOP";

interface AgentDecision {
  action: ActionType;
  command: string | null;
  sleepMs: number | null;
  note: string | null;
}

interface IterationRecord {
  id: string;
  timestamp: number;
  step: number;
  promptSummary: string;
  decision: AgentDecision;
  result: ExecutionResult | null;
  derivedSummary: string;
}

interface ExecutionResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
}

// ============================================================================
// Memory Storage (uses plugin-inmemorydb's MemoryStorage directly)
// ============================================================================

class AgentMemory {
  private storage: MemoryStorage;
  private collectionName = "autonomous_iterations";

  constructor() {
    this.storage = new MemoryStorage();
  }

  async store(record: IterationRecord): Promise<void> {
    const existing = (await this.storage.get(this.collectionName)) as IterationRecord[] | null;
    const records = existing || [];
    records.push(record);
    await this.storage.set(this.collectionName, records);
  }

  async getRecentRecords(count: number): Promise<IterationRecord[]> {
    const existing = (await this.storage.get(this.collectionName)) as IterationRecord[] | null;
    const records = existing || [];
    return records.slice(-count);
  }

  async getIterationCount(): Promise<number> {
    const existing = (await this.storage.get(this.collectionName)) as IterationRecord[] | null;
    return existing?.length || 0;
  }
}

// ============================================================================
// XML Parser for Agent Output
// ============================================================================

function parseAgentOutput(output: string): AgentDecision {
  const defaultDecision: AgentDecision = {
    action: "SLEEP",
    command: null,
    sleepMs: 1000,
    note: "Failed to parse agent output",
  };

  // Remove <think> tags if present (Qwen3 thinking mode)
  const cleanedOutput = output.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

  // Extract action
  const actionMatch = cleanedOutput.match(/<action>\s*(RUN|SLEEP|STOP)\s*<\/action>/i);
  if (!actionMatch) {
    logger.warn("Could not extract action from agent output");
    return defaultDecision;
  }

  const action = actionMatch[1].toUpperCase() as ActionType;

  // Extract command (for RUN action)
  let command: string | null = null;
  if (action === "RUN") {
    const cmdMatch = cleanedOutput.match(/<command>\s*([\s\S]*?)\s*<\/command>/i);
    if (cmdMatch) {
      command = cmdMatch[1].trim();
    } else {
      logger.warn("RUN action without command, defaulting to SLEEP");
      return { ...defaultDecision, note: "RUN action without command" };
    }
  }

  // Extract sleepMs (for SLEEP action)
  let sleepMs: number | null = null;
  if (action === "SLEEP") {
    const sleepMatch = cleanedOutput.match(/<sleepMs>\s*(\d+)\s*<\/sleepMs>/i);
    sleepMs = sleepMatch ? Number.parseInt(sleepMatch[1], 10) : 1000;
  }

  // Extract note (optional)
  const noteMatch = cleanedOutput.match(/<note>\s*([\s\S]*?)\s*<\/note>/i);
  const note = noteMatch ? noteMatch[1].trim() : null;

  return { action, command, sleepMs, note };
}

// ============================================================================
// Additional Forbidden Commands (beyond plugin-shell defaults)
// ============================================================================

const ADDITIONAL_FORBIDDEN_COMMANDS = [
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "netcat",
  "socat",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "kill",
  "pkill",
  "killall",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "chown",
  "chmod",
  "chgrp",
];

function isCommandAllowed(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  const baseCommand = trimmed.split(/\s+/)[0];

  for (const forbidden of ADDITIONAL_FORBIDDEN_COMMANDS) {
    if (baseCommand === forbidden || baseCommand.endsWith(`/${forbidden}`)) {
      return false;
    }
  }

  // Check for dangerous patterns
  const dangerousPatterns = [
    /\.\.\//,          // Path traversal
    /\$\(/,            // Command substitution
    /`/,               // Backtick command substitution
    /;\s*rm\s/,        // Chained rm
    /&&\s*rm\s/,       // Chained rm
    /\|\|\s*rm\s/,     // Chained rm
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Prompt Template
// ============================================================================

function buildPrompt(
  config: AutonomousConfig,
  currentDir: string,
  shellHistory: string[],
  memoryRecords: IterationRecord[],
  dirListing: string,
): string {
  const memoryContext = memoryRecords
    .map((r) => {
      const resultInfo = r.result
        ? `exit=${r.result.exitCode}, stdout=${r.result.stdout.slice(0, 100)}`
        : "no result";
      return `[Step ${r.step}] ${r.decision.action}${r.decision.command ? `: ${r.decision.command}` : ""} → ${resultInfo}`;
    })
    .join("\n");

  const historyContext = shellHistory.length > 0
    ? shellHistory.slice(-5).join("\n")
    : "(no shell history yet)";

  return `You are an autonomous agent operating in a sandboxed directory.

## Your Environment
- Sandbox directory: ${config.sandboxDir}
- Current working directory: ${currentDir}
- Files in current directory:
${dirListing || "(empty or unable to list)"}

## Your Capabilities
- You can run shell commands (ls, cat, echo, touch, mkdir, cp, mv, grep, find, head, tail, wc, sort, uniq, date)
- You CANNOT run: networking commands, interpreters (python, node), process control (kill), or system commands
- All file operations are restricted to the sandbox directory

## Recent Memory
${memoryContext || "(no previous iterations)"}

## Recent Shell History
${historyContext}

## Your Task
You are a curious autonomous agent. Your goal is to:
1. Explore your sandbox environment
2. Create and organize files as you see fit
3. Keep a log of your activities
4. Find interesting things to do within your constraints

Think about what would be useful or interesting to do next, then output your decision.

## Output Format
Respond with EXACTLY one of these XML structures:

To run a command:
<action>RUN</action>
<command>your shell command here</command>
<note>brief explanation of what you're doing</note>

To sleep/wait:
<action>SLEEP</action>
<sleepMs>milliseconds to sleep</sleepMs>
<note>why you're waiting</note>

To stop the agent:
<action>STOP</action>
<note>why you're stopping</note>

IMPORTANT: Output ONLY the XML tags. No other text before or after.`;
}

// ============================================================================
// Autonomous Agent
// ============================================================================

class AutonomousAgent {
  private runtime: AgentRuntime;
  private shellService: ShellService | null = null;
  private memory: AgentMemory;
  private config: AutonomousConfig;
  private iterationCount = 0;
  private consecutiveFailures = 0;
  private isRunning = false;
  private abortController: AbortController;

  constructor(runtime: AgentRuntime, config: AutonomousConfig) {
    this.runtime = runtime;
    this.memory = new AgentMemory();
    this.config = config;
    this.abortController = new AbortController();
  }

  async initialize(): Promise<void> {
    // Ensure sandbox directory exists
    if (!fs.existsSync(this.config.sandboxDir)) {
      fs.mkdirSync(this.config.sandboxDir, { recursive: true });
      logger.info(`Created sandbox directory: ${this.config.sandboxDir}`);
    }

    // Create a welcome file in the sandbox
    const welcomePath = path.join(this.config.sandboxDir, "WELCOME.txt");
    if (!fs.existsSync(welcomePath)) {
      fs.writeFileSync(
        welcomePath,
        `Welcome, Autonomous Agent!

This is your sandbox. You can:
- Create files and directories
- Read and modify files
- Explore with ls, cat, find, grep, etc.

To stop the agent, create a file named "STOP" in this directory.

Have fun exploring!
`
      );
    }

    // Get ShellService from runtime
    const shellServices = this.runtime.services.get("shell");
    if (shellServices && shellServices.length > 0) {
      this.shellService = shellServices[0] as ShellService;
    }

    if (!this.shellService) {
      throw new Error("ShellService not available. Ensure plugin-shell is registered.");
    }

    logger.success("Autonomous agent initialized");
    logger.info(`Sandbox: ${this.config.sandboxDir}`);
    logger.info(`Stop file: ${this.config.stopOnFile}`);
  }

  private shouldStop(): boolean {
    // Check for STOP file
    if (fs.existsSync(this.config.stopOnFile)) {
      logger.info("STOP file detected, stopping agent");
      return true;
    }

    // Check iteration limit
    if (this.iterationCount >= this.config.maxIterations) {
      logger.info(`Max iterations (${this.config.maxIterations}) reached, stopping agent`);
      return true;
    }

    // Check consecutive failure limit
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      logger.warn(`Max consecutive failures (${this.config.maxConsecutiveFailures}) reached, stopping agent`);
      return true;
    }

    // Check AUTONOMY_ENABLED env
    if (process.env.AUTONOMY_ENABLED === "false") {
      logger.info("AUTONOMY_ENABLED=false, stopping agent");
      return true;
    }

    return false;
  }

  private async getDirectoryListing(): Promise<string> {
    if (!this.shellService) return "(shell service unavailable)";

    const result = await this.shellService.executeCommand("ls -la", this.config.conversationId);
    if (result.success) {
      return result.stdout;
    }
    return `(failed to list: ${result.stderr})`;
  }

  private async think(): Promise<AgentDecision> {
    const currentDir = this.shellService?.getCurrentDirectory() || this.config.sandboxDir;
    const shellHistory = this.shellService
      ?.getCommandHistory(this.config.conversationId, 10)
      .map((h) => `$ ${h.command}`) || [];
    const memoryRecords = await this.memory.getRecentRecords(this.config.memoryContextSize);
    const dirListing = await this.getDirectoryListing();

    const prompt = buildPrompt(this.config, currentDir, shellHistory, memoryRecords, dirListing);

    logger.debug("Generating agent decision...");

    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: ["</note>"],
    });

    if (typeof response !== "string") {
      throw new Error("Model returned non-string response");
    }

    // Add closing tag if truncated
    let fullResponse = response;
    if (!fullResponse.includes("</note>")) {
      fullResponse += "</note>";
    }

    logger.debug(`Model response: ${fullResponse.slice(0, 200)}...`);

    return parseAgentOutput(fullResponse);
  }

  private async act(decision: AgentDecision): Promise<ExecutionResult | null> {
    if (decision.action === "STOP") {
      logger.info(`Agent decided to stop: ${decision.note}`);
      this.isRunning = false;
      return null;
    }

    if (decision.action === "SLEEP") {
      const sleepMs = decision.sleepMs || 1000;
      logger.info(`Agent sleeping for ${sleepMs}ms: ${decision.note}`);
      await this.sleep(sleepMs);
      return null;
    }

    if (decision.action === "RUN" && decision.command) {
      // Validate command before execution
      if (!isCommandAllowed(decision.command)) {
        logger.warn(`Blocked forbidden command: ${decision.command}`);
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: "Command blocked by security policy",
          cwd: this.shellService?.getCurrentDirectory() || this.config.sandboxDir,
        };
      }

      logger.info(`Executing: ${decision.command}`);

      if (!this.shellService) {
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: "Shell service unavailable",
          cwd: this.config.sandboxDir,
        };
      }

      const result = await this.shellService.executeCommand(
        decision.command,
        this.config.conversationId
      );

      const executionResult: ExecutionResult = {
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 1000), // Truncate for storage
        stderr: result.stderr.slice(0, 500),
        cwd: result.executedIn,
      };

      if (result.success) {
        logger.info(`Command succeeded (exit ${result.exitCode})`);
        if (result.stdout) {
          logger.debug(`stdout: ${result.stdout.slice(0, 200)}`);
        }
      } else {
        logger.warn(`Command failed (exit ${result.exitCode}): ${result.stderr}`);
      }

      return executionResult;
    }

    return null;
  }

  private generateSummary(decision: AgentDecision, result: ExecutionResult | null): string {
    if (decision.action === "STOP") {
      return `Stopped: ${decision.note || "agent decided to stop"}`;
    }

    if (decision.action === "SLEEP") {
      return `Slept ${decision.sleepMs}ms: ${decision.note || "waiting"}`;
    }

    if (decision.action === "RUN" && result) {
      const status = result.success ? "OK" : "FAIL";
      const output = result.stdout.slice(0, 50) || result.stderr.slice(0, 50) || "(no output)";
      return `${status}: ${decision.command} → ${output}`;
    }

    return "Unknown action";
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async run(): Promise<void> {
    this.isRunning = true;

    // Setup signal handlers for graceful shutdown
    const shutdown = () => {
      logger.info("Received shutdown signal, stopping agent...");
      this.isRunning = false;
      this.abortController.abort();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    logger.info("Starting autonomous loop...");

    while (this.isRunning && !this.shouldStop()) {
      this.iterationCount++;
      const iterationId = uuidv4();
      const timestamp = Date.now();

      logger.info(`\n=== Iteration ${this.iterationCount} ===`);

      let decision: AgentDecision;
      let result: ExecutionResult | null = null;

      // Think phase
      try {
        decision = await this.think();
        this.consecutiveFailures = 0;
      } catch (thinkError) {
        logger.error(`Think phase failed: ${thinkError}`);
        this.consecutiveFailures++;
        decision = {
          action: "SLEEP",
          command: null,
          sleepMs: this.config.loopIntervalMs * 2,
          note: `Think phase error: ${thinkError}`,
        };
      }

      // Act phase
      try {
        result = await this.act(decision);
      } catch (actError) {
        logger.error(`Act phase failed: ${actError}`);
        this.consecutiveFailures++;
        result = {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `Action error: ${actError}`,
          cwd: this.shellService?.getCurrentDirectory() || this.config.sandboxDir,
        };
      }

      // Store iteration record
      const summary = this.generateSummary(decision, result);
      const record: IterationRecord = {
        id: iterationId,
        timestamp,
        step: this.iterationCount,
        promptSummary: `Iteration ${this.iterationCount}`,
        decision,
        result,
        derivedSummary: summary,
      };

      await this.memory.store(record);
      logger.debug(`Stored iteration record: ${summary}`);

      // Inter-iteration delay
      if (this.isRunning && decision.action !== "SLEEP") {
        await this.sleep(this.config.loopIntervalMs);
      }
    }

    logger.info(`\nAutonomous loop ended after ${this.iterationCount} iterations`);

    // Cleanup signal handlers
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║           AUTONOMOUS SELF-LOOPING AGENT (TypeScript)              ║
║                                                                   ║
║  A sandboxed agent that thinks locally, acts via shell,           ║
║  and remembers in ephemeral memory.                               ║
╚═══════════════════════════════════════════════════════════════════╝
`);

  // Load configuration
  const config = loadConfig();

  logger.info("Configuration:");
  logger.info(`  Sandbox:         ${config.sandboxDir}`);
  logger.info(`  Loop interval:   ${config.loopIntervalMs}ms`);
  logger.info(`  Max iterations:  ${config.maxIterations}`);
  logger.info(`  Agent ID:        ${config.agentId}`);

  // Verify environment variables for local-ai
  if (!process.env.LOCAL_SMALL_MODEL) {
    logger.warn("LOCAL_SMALL_MODEL not set, will use default or auto-download");
  }

  // Set shell configuration
  process.env.SHELL_ENABLED = process.env.SHELL_ENABLED || "true";
  process.env.SHELL_ALLOWED_DIRECTORY = config.sandboxDir;

  // Create runtime with plugins
  const runtime = new AgentRuntime({
    agentId: config.agentId,
    character: {
      name: "AutonomousAgent",
      bio: ["A curious autonomous agent exploring its sandbox environment."],
      system: "You are an autonomous agent. Be concise. Output only the required XML format.",
      modelProvider: "local",
    },
    plugins: [localAiPlugin, shellPlugin, inMemoryPlugin],
    logLevel: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") || "info",
  });

  // Wait for runtime initialization
  await runtime.initPromise;
  logger.success("Runtime initialized");

  // Create and initialize agent
  const agent = new AutonomousAgent(runtime, config);
  await agent.initialize();

  // Run the autonomous loop
  await agent.run();

  logger.info("Agent shutdown complete");
  process.exit(0);
}

// Run main
main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
