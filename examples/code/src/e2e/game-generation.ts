#!/usr/bin/env bun

/**
 * E2E Tests for Game Generation
 *
 * This script tests that each of the 4 primary agent types can successfully
 * create working games:
 *
 * 1. TypeScript Guessing Game (tested with eliza or codex)
 * 2. Rust Blackjack Game (tested with claude-code or sweagent)
 * 3. Python Adventure Game (tested with eliza or sweagent)
 *
 * Requirements:
 * - ANTHROPIC_API_KEY or OPENAI_API_KEY must be set
 * - The script creates an isolated git worktree for each test
 * - Files created during tests are cleaned up after
 */

import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentOrchestratorService } from "@elizaos/plugin-agent-orchestrator";
import { initializeAgent, shutdownAgent } from "../lib/agent.js";
import { setCwd } from "../lib/cwd.js";
import type { SubAgentType } from "../types.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

interface TestResult {
  name: string;
  agent: SubAgentType;
  language: string;
  passed: boolean;
  error?: string;
  filesCreated: string[];
  executionTime: number;
}

interface GameTest {
  name: string;
  description: string;
  language: "typescript" | "rust" | "python";
  preferredAgents: SubAgentType[];
  expectedFiles: string[];
  verifyFn: (workdir: string) => Promise<{ ok: boolean; error?: string }>;
}

// ============================================================================
// Utilities
// ============================================================================

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function git(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: opts?.cwd,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { stdout: "", stderr: e.message, exitCode: 1 };
  }
}

async function shell(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const timeout = opts?.timeout ?? 30000;
    let stdout = "";
    let stderr = "";
    let killed = false;

    const proc = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ stdout, stderr: "timeout", exitCode: 124 });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

async function getRepoRoot(startDir: string): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], { cwd: startDir });
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    throw new Error(`Not a git repository: ${r.stderr || startDir}`);
  }
  return r.stdout.trim();
}

async function createDetachedWorktree(repoRoot: string): Promise<string> {
  const rand = crypto.randomBytes(6).toString("hex");
  const dir = path.join(
    repoRoot,
    ".eliza",
    "game-e2e",
    `${Date.now()}-${rand}`,
  );
  const add = await git(["worktree", "add", "--detach", dir, "HEAD"], {
    cwd: repoRoot,
  });
  if (add.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr}`);
  }
  return dir;
}

async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  await git(["worktree", "remove", "--force", dir], { cwd: repoRoot });
  await git(["worktree", "prune"], { cwd: repoRoot });
}

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fs.stat(filepath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Game Definitions
// ============================================================================

const TYPESCRIPT_GUESSING_GAME: GameTest = {
  name: "TypeScript Guessing Game",
  description: `Create a simple number guessing game in TypeScript.

Requirements:
- Create a file called \`guessing-game.ts\` in the current directory
- The game should:
  1. Generate a random number between 1 and 100
  2. Have a function \`guess(n: number): string\` that returns "too low", "too high", or "correct!"
  3. Export the guess function and a \`secretNumber\` variable
- Keep it simple, no external dependencies
- Use TypeScript syntax (type annotations)`,
  language: "typescript",
  preferredAgents: ["eliza"],
  expectedFiles: ["guessing-game.ts"],
  verifyFn: async (workdir: string) => {
    const filepath = path.join(workdir, "guessing-game.ts");
    if (!(await fileExists(filepath))) {
      return { ok: false, error: "guessing-game.ts not created" };
    }

    const content = await fs.readFile(filepath, "utf-8");

    // Check for required elements
    if (
      !content.includes("function guess") &&
      !content.includes("const guess")
    ) {
      return { ok: false, error: "Missing guess function" };
    }
    if (!content.includes("secretNumber") && !content.includes("secret")) {
      return { ok: false, error: "Missing secret number" };
    }
    if (!content.includes("number")) {
      return { ok: false, error: "Missing type annotations" };
    }

    // Try to compile
    const tsc = await shell("bunx", ["tsc", "--noEmit", filepath], {
      cwd: workdir,
      timeout: 15000,
    });
    if (tsc.exitCode !== 0) {
      return {
        ok: false,
        error: `TypeScript compilation failed: ${tsc.stderr}`,
      };
    }

    return { ok: true };
  },
};

const RUST_BLACKJACK_GAME: GameTest = {
  name: "Rust Blackjack Game",
  description: `Create a simple blackjack game module in Rust.

Requirements:
- Create a file called \`blackjack.rs\` in the current directory
- The module should include:
  1. A Card struct with suit and value fields
  2. A function \`card_value(card: &Card) -> u8\` that returns the card's point value
  3. A function \`is_blackjack(hand: &[Card]) -> bool\` that checks for natural blackjack (21 with 2 cards)
  4. Ace = 1 or 11, Face cards = 10
- Keep it simple, no external dependencies
- Use proper Rust idioms`,
  language: "rust",
  preferredAgents: ["eliza"],
  expectedFiles: ["blackjack.rs"],
  verifyFn: async (workdir: string) => {
    const filepath = path.join(workdir, "blackjack.rs");
    if (!(await fileExists(filepath))) {
      return { ok: false, error: "blackjack.rs not created" };
    }

    const content = await fs.readFile(filepath, "utf-8");

    // Check for required elements
    if (!content.includes("struct Card")) {
      return { ok: false, error: "Missing Card struct" };
    }
    if (!content.includes("card_value") && !content.includes("fn value")) {
      return { ok: false, error: "Missing card_value function" };
    }
    if (!content.includes("blackjack") && !content.includes("is_21")) {
      return { ok: false, error: "Missing blackjack check function" };
    }

    // Try to check syntax with rustc
    const rustc = await shell(
      "rustc",
      ["--edition", "2021", "--emit=metadata", "-o", "/dev/null", filepath],
      {
        cwd: workdir,
        timeout: 30000,
      },
    );
    // Allow warnings, only fail on errors
    if (rustc.exitCode !== 0 && !rustc.stderr.includes("warning")) {
      return { ok: false, error: `Rust compilation failed: ${rustc.stderr}` };
    }

    return { ok: true };
  },
};

const PYTHON_ADVENTURE_GAME: GameTest = {
  name: "Python Adventure Game",
  description: `Create a simple text adventure game engine in Python.

Requirements:
- Create a file called \`adventure.py\` in the current directory
- The module should include:
  1. A Room class with name, description, and exits (dict of direction -> room_name)
  2. A Player class with current_room and inventory (list)
  3. A \`move(player, direction)\` function that moves the player
  4. A \`look(player, rooms)\` function that describes the current room
- Keep it simple, no external dependencies
- Use type hints`,
  language: "python",
  preferredAgents: ["eliza"],
  expectedFiles: ["adventure.py"],
  verifyFn: async (workdir: string) => {
    const filepath = path.join(workdir, "adventure.py");
    if (!(await fileExists(filepath))) {
      return { ok: false, error: "adventure.py not created" };
    }

    const content = await fs.readFile(filepath, "utf-8");

    // Check for required elements
    if (!content.includes("class Room")) {
      return { ok: false, error: "Missing Room class" };
    }
    if (!content.includes("class Player")) {
      return { ok: false, error: "Missing Player class" };
    }
    if (!content.includes("def move")) {
      return { ok: false, error: "Missing move function" };
    }
    if (!content.includes("def look")) {
      return { ok: false, error: "Missing look function" };
    }

    // Check Python syntax
    const python = await shell("python3", ["-m", "py_compile", filepath], {
      cwd: workdir,
      timeout: 10000,
    });
    if (python.exitCode !== 0) {
      return { ok: false, error: `Python syntax error: ${python.stderr}` };
    }

    return { ok: true };
  },
};

const GAME_TESTS: GameTest[] = [
  TYPESCRIPT_GUESSING_GAME,
  RUST_BLACKJACK_GAME,
  PYTHON_ADVENTURE_GAME,
];

// ============================================================================
// Test Runner
// ============================================================================

function getAvailableAgents(): SubAgentType[] {
  const openai = process.env.OPENAI_API_KEY?.trim();
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  const _provider = (process.env.ELIZA_CODE_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  const agents: SubAgentType[] = [];

  // Eliza works with any provider
  if (openai || anthropic) {
    agents.push("eliza");
  }

  // Codex requires OpenAI
  if (openai) {
    agents.push("codex");
  }

  // Claude Code requires Anthropic
  if (anthropic) {
    agents.push("claude-code");
  }

  // SWE-agent works with any provider
  if (openai || anthropic) {
    agents.push("sweagent");
  }

  return agents;
}

function selectAgent(
  preferred: SubAgentType[],
  available: SubAgentType[],
): SubAgentType | null {
  for (const agent of preferred) {
    if (available.includes(agent)) {
      return agent;
    }
  }
  // Fallback to any available
  return available[0] ?? null;
}

async function runGameTest(
  service: AgentOrchestratorService,
  test: GameTest,
  agent: SubAgentType,
  workdir: string,
): Promise<TestResult> {
  const startTime = Date.now();

  log(`Running: ${test.name} with ${agent}`);

  try {
    // Create task
    const task = await service.createTask(
      test.name,
      test.description,
      undefined,
      agent,
    );
    const taskId = task.id ?? "";

    if (!taskId) {
      return {
        name: test.name,
        agent,
        language: test.language,
        passed: false,
        error: "Failed to create task",
        filesCreated: [],
        executionTime: Date.now() - startTime,
      };
    }

    log(`  Task created: ${taskId}`);

    // Execute task
    await service.startTaskExecution(taskId);

    const finished = await service.getTask(taskId);
    const result = finished?.metadata.result;
    const status = finished?.metadata.status;

    log(`  Status: ${status}`);

    if (status !== "completed" || !result?.success) {
      return {
        name: test.name,
        agent,
        language: test.language,
        passed: false,
        error:
          result?.error ??
          result?.summary ??
          "Task did not complete successfully",
        filesCreated: result?.filesCreated ?? [],
        executionTime: Date.now() - startTime,
      };
    }

    // Verify the game was created correctly
    const verify = await test.verifyFn(workdir);

    return {
      name: test.name,
      agent,
      language: test.language,
      passed: verify.ok,
      error: verify.error,
      filesCreated: result.filesCreated,
      executionTime: Date.now() - startTime,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      name: test.name,
      agent,
      language: test.language,
      passed: false,
      error,
      filesCreated: [],
      executionTime: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  log("=== Game Generation E2E Tests ===");
  log("");

  const available = getAvailableAgents();
  if (available.length === 0) {
    console.error(
      "ERROR: No agents available. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
    process.exit(1);
  }

  log(`Available agents: ${available.join(", ")}`);
  log("");

  const repoRoot = await getRepoRoot(process.cwd());
  const results: TestResult[] = [];

  for (const test of GAME_TESTS) {
    const agent = selectAgent(test.preferredAgents, available);
    if (!agent) {
      log(`SKIP: ${test.name} - no suitable agent available`);
      results.push({
        name: test.name,
        agent: "eliza",
        language: test.language,
        passed: false,
        error: "No suitable agent available",
        filesCreated: [],
        executionTime: 0,
      });
      continue;
    }

    // Create isolated worktree for this test
    const worktree = await createDetachedWorktree(repoRoot);
    log(`Using worktree: ${worktree}`);

    try {
      const cwdResult = await setCwd(worktree);
      if (!cwdResult.success) {
        throw new Error(
          `Failed to set CWD: ${cwdResult.error ?? cwdResult.path}`,
        );
      }
      process.chdir(cwdResult.path);

      // Initialize agent for this test
      const runtime = await initializeAgent();
      const service = runtime.getService(
        "CODE_TASK",
      ) as AgentOrchestratorService | null;

      if (!service) {
        throw new Error("CodeTaskService not available");
      }

      const result = await runGameTest(service, test, agent, worktree);
      results.push(result);

      await shutdownAgent(runtime);
    } finally {
      await removeWorktree(repoRoot, worktree);
    }

    log("");
  }

  // Print results
  log("=== Results ===");
  log("");

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const status = r.passed ? "✓ PASS" : "✗ FAIL";
    const time = `${(r.executionTime / 1000).toFixed(1)}s`;
    log(`${status} | ${r.name} (${r.agent}) [${r.language}] - ${time}`);
    if (!r.passed && r.error) {
      log(`       Error: ${r.error}`);
    }
    if (r.filesCreated.length > 0) {
      log(`       Files: ${r.filesCreated.join(", ")}`);
    }

    if (r.passed) passed++;
    else failed++;
  }

  log("");
  log(`Total: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run if executed directly
await main();
