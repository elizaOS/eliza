#!/usr/bin/env bun

/**
 * Bootstrap external agent frameworks and simulator sources needed by ScamBench.
 *
 * This script is intentionally idempotent and best-effort:
 * - clones public repos when missing
 * - installs/builds Hermes and OpenClaw
 * - clones Eliza for reference while the benchmark bridge uses Feed's local packages
 * - prepares ClawBench and its TrajectoryRL OpenClaw fork for deterministic simulation
 * - reports missing provider API keys needed for live benchmark runs
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type FrameworkSpec = {
  name: string;
  repoUrl: string;
  repoPath: string;
  install?: () => Promise<void>;
};

const FEED_ROOT = join(import.meta.dir, "..");
const WORKSPACE_ROOT = join(FEED_ROOT, "..");
const EXTERNAL_SOURCES_ROOT = join(WORKSPACE_ROOT, "external-sources");

function readEnvFiles(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of [
    join(WORKSPACE_ROOT, ".env"),
    join(WORKSPACE_ROOT, ".env.local"),
    join(FEED_ROOT, ".env"),
    join(FEED_ROOT, ".env.local"),
  ]) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const [rawKey, ...rest] = line.split("=");
      const key = rawKey.trim();
      const value = rest
        .join("=")
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (key) merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  return merged;
}

async function runCommand(
  command: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
}

async function ensureRepo(spec: FrameworkSpec): Promise<void> {
  if (existsSync(spec.repoPath)) {
    console.log(`   ✓ ${spec.name}: repository present`);
    return;
  }
  console.log(`   ⬇ ${spec.name}: cloning ${spec.repoUrl}`);
  await runCommand(
    ["git", "clone", "--depth", "1", spec.repoUrl, spec.repoPath],
    WORKSPACE_ROOT,
  );
}

async function ensureHermes(): Promise<void> {
  const repoPath = join(EXTERNAL_SOURCES_ROOT, "hermes-agent");
  const venvPython = join(repoPath, ".venv", "bin", "python");
  if (!existsSync(join(repoPath, "pyproject.toml"))) {
    console.log("   ⚠️  Hermes: pyproject.toml missing, skipping install");
    return;
  }
  if (!existsSync(venvPython)) {
    console.log("   📦 Hermes: creating .venv");
    await runCommand(["uv", "venv", ".venv", "--python", "python3"], repoPath);
  } else {
    console.log("   ✓ Hermes: .venv already present");
  }
  console.log("   📦 Hermes: installing editable package");
  await runCommand(
    ["uv", "pip", "install", "--python", venvPython, "-e", "."],
    repoPath,
  );
}

async function ensureOpenClaw(): Promise<void> {
  const repoPath = join(EXTERNAL_SOURCES_ROOT, "openclaw");
  const builtEntry = join(repoPath, "dist", "index.js");
  if (!existsSync(join(repoPath, "package.json"))) {
    console.log("   ⚠️  OpenClaw: package.json missing, skipping install");
    return;
  }
  console.log("   📦 OpenClaw: installing dependencies");
  await runCommand(
    ["corepack", "pnpm", "install", "--frozen-lockfile"],
    repoPath,
  );
  if (!existsSync(builtEntry)) {
    console.log("   🏗 OpenClaw: building dist");
    await runCommand(["corepack", "pnpm", "build"], repoPath);
  } else {
    console.log("   ✓ OpenClaw: dist already built");
  }
}

async function ensureElizaReferenceClone(): Promise<void> {
  const repoPath = join(EXTERNAL_SOURCES_ROOT, "eliza");
  if (existsSync(repoPath)) {
    console.log("   ✓ ElizaOS: repository present");
    return;
  }
  console.log("   ⬇ ElizaOS: cloning reference repository");
  await runCommand(
    [
      "git",
      "clone",
      "--depth",
      "1",
      "https://github.com/elizaos/eliza.git",
      repoPath,
    ],
    WORKSPACE_ROOT,
  );
  console.log(
    "   ✓ ElizaOS: reference clone ready (ScamBench uses Feed's installed eliza packages at runtime)",
  );
}

async function ensureClawBench(): Promise<void> {
  const repoPath = join(EXTERNAL_SOURCES_ROOT, "clawbench");
  const venvPython = join(repoPath, ".venv", "bin", "python");
  if (!existsSync(join(repoPath, "requirements.txt"))) {
    console.log(
      "   ⚠️  ClawBench: requirements.txt missing, skipping host install",
    );
    return;
  }
  if (!existsSync(venvPython)) {
    console.log("   📦 ClawBench: creating .venv");
    await runCommand(["uv", "venv", ".venv", "--python", "python3"], repoPath);
  } else {
    console.log("   ✓ ClawBench: .venv already present");
  }
  console.log("   📦 ClawBench: installing host runner requirements");
  await runCommand(
    [
      "uv",
      "pip",
      "install",
      "--python",
      venvPython,
      "-r",
      "requirements.txt",
      "-r",
      "requirements-mock.txt",
    ],
    repoPath,
  );
}

async function main() {
  if (process.env.FEED_SKIP_AGENT_FRAMEWORKS_BOOTSTRAP === "1") {
    console.log(
      "🤖 Skipping agent framework bootstrap (FEED_SKIP_AGENT_FRAMEWORKS_BOOTSTRAP=1)",
    );
    return;
  }

  console.log("\n🤖 Bootstrapping ScamBench agent frameworks...");
  mkdirSync(EXTERNAL_SOURCES_ROOT, { recursive: true });

  const frameworks: FrameworkSpec[] = [
    {
      name: "Hermes",
      repoUrl: "https://github.com/NousResearch/hermes-agent.git",
      repoPath: join(EXTERNAL_SOURCES_ROOT, "hermes-agent"),
      install: ensureHermes,
    },
    {
      name: "OpenClaw",
      repoUrl: "https://github.com/openclaw/openclaw.git",
      repoPath: join(EXTERNAL_SOURCES_ROOT, "openclaw"),
      install: ensureOpenClaw,
    },
    {
      name: "ElizaOS",
      repoUrl: "https://github.com/elizaos/eliza.git",
      repoPath: join(EXTERNAL_SOURCES_ROOT, "eliza"),
      install: ensureElizaReferenceClone,
    },
    {
      name: "ClawBench",
      repoUrl: "https://github.com/trajectoryRL/clawbench.git",
      repoPath: join(EXTERNAL_SOURCES_ROOT, "clawbench"),
      install: ensureClawBench,
    },
    {
      name: "TrajectoryRL OpenClaw",
      repoUrl: "https://github.com/trajectoryRL/openclaw.git",
      repoPath: join(EXTERNAL_SOURCES_ROOT, "trajectoryrl-openclaw"),
    },
  ];

  for (const framework of frameworks) {
    try {
      await ensureRepo(framework);
      if (framework.install) {
        await framework.install();
      }
    } catch (error) {
      console.log(
        `   ⚠️  ${framework.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const env = readEnvFiles();
  const missingKeys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
  ].filter((key) => !env[key]);

  if (missingKeys.length > 0) {
    console.log(
      `   ⚠️  Missing supported live-provider keys: ${missingKeys.join(", ")}`,
    );
  } else {
    console.log(
      "   ✓ Live-provider keys for OpenAI, Anthropic, and Groq are present",
    );
  }
  console.log("   ✅ Agent framework bootstrap complete\n");
}

main().catch((error) => {
  console.error("Agent framework bootstrap failed:", error);
  process.exit(1);
});
