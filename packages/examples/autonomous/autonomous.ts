import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  logger,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import inmemorydbPlugin from "@elizaos/plugin-inmemorydb";
import localAiPlugin from "@elizaos/plugin-local-ai";
import { type ShellService, shellPlugin } from "@elizaos/plugin-shell";
import { v4 as uuidv4 } from "uuid";

type AgentDecision =
  | { action: "RUN"; command: string; note: string }
  | { action: "SLEEP"; sleepMs: number; note: string }
  | { action: "STOP"; note: string };

type StepRecord = {
  step: number;
  decidedAt: number;
  goal: string;
  decision: AgentDecision;
  shell?: {
    executed: boolean;
    command?: string;
    success?: boolean;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    executedIn?: string;
    error?: string;
  };
};

const AUTONOMY_TABLE = "autonomous_steps";

function envString(name: string, fallback: string): string {
  const v = process.env[name];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (typeof v !== "string") return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n...<truncated ${text.length - maxLen} chars>...`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractTag(text: string, tagName: string): string | null {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const startIdx = text.indexOf(startTag);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(endTag, startIdx + startTag.length);
  if (endIdx === -1) return null;
  return text.slice(startIdx + startTag.length, endIdx).trim();
}

function extractResponseBlock(text: string): string | null {
  const start = text.indexOf("<response>");
  const end = text.indexOf("</response>");
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + "</response>".length);
}

function parseDecision(raw: string): AgentDecision | null {
  const block = extractResponseBlock(raw);
  const xml = block ?? raw;

  const actionRaw = extractTag(xml, "action")?.trim().toUpperCase();
  if (!actionRaw) return null;

  const note = extractTag(xml, "note") ?? "";

  switch (actionRaw) {
    case "STOP":
      return { action: "STOP", note };
    case "SLEEP": {
      const sleepRaw = extractTag(xml, "sleepMs");
      const sleepMsParsed = sleepRaw ? Number(sleepRaw) : NaN;
      if (!Number.isFinite(sleepMsParsed)) return null;
      return {
        action: "SLEEP",
        sleepMs: clamp(sleepMsParsed, 100, 60_000),
        note,
      };
    }
    case "RUN": {
      const command = extractTag(xml, "command");
      if (!command) return null;
      return { action: "RUN", command, note };
    }
    default:
      return null;
  }
}

function baseCommand(command: string): string {
  const trimmed = command.trim();
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

function isCommandAllowed(
  command: string,
  allowedBaseCommands: readonly string[],
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return false;

  // Disallow shell meta-characters to avoid `sh -c` execution paths.
  const meta = ["|", ">", "<", ";", "&&", "||"];
  if (meta.some((m) => trimmed.includes(m))) return false;

  const cmd = baseCommand(trimmed);
  return allowedBaseCommands.includes(cmd);
}

function decisionPrompt(params: {
  goal: string;
  allowedDirectory: string;
  allowedCommands: readonly string[];
  recentSteps: string;
}): string {
  const allowedCmdList = params.allowedCommands.join(", ");
  return `
You are an autonomous agent running inside a sandbox directory on the local machine.

GOAL:
${params.goal}

SANDBOX:
- You may ONLY run shell commands inside: ${params.allowedDirectory}
- You may ONLY use these base commands: ${allowedCmdList}
- Never use networking, package managers, or process control.
- If you cannot make progress safely, choose SLEEP.

RECENT HISTORY (most recent last):
${params.recentSteps}

Choose exactly ONE next step and output ONLY this XML (no extra text):
<response>
  <action>RUN|SLEEP|STOP</action>
  <command>...</command>
  <sleepMs>...</sleepMs>
  <note>short reason</note>
</response>

Rules:
- If action is RUN, include <command> and omit <sleepMs>.
- If action is SLEEP, include <sleepMs> (100-60000) and omit <command>.
- If action is STOP, omit both <command> and <sleepMs>.
- Keep output short.
`.trim();
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..");

  const defaultSandboxDir = path.join(
    repoRoot,
    "examples",
    "autonomous",
    "sandbox",
  );
  const allowedDirectory = envString(
    "SHELL_ALLOWED_DIRECTORY",
    defaultSandboxDir,
  );

  // Ensure sandbox exists before plugin-shell reads env (it throws if missing).
  await fs.mkdir(allowedDirectory, { recursive: true });

  // If user didn't set it, we still set it so plugin-shell is constrained even if enabled.
  process.env.SHELL_ALLOWED_DIRECTORY = allowedDirectory;

  const goalFile = envString(
    "AUTONOMY_GOAL_FILE",
    path.join(allowedDirectory, "GOAL.txt"),
  );
  const stopFile = envString(
    "AUTONOMY_STOP_FILE",
    path.join(allowedDirectory, "STOP"),
  );
  const intervalMs = clamp(
    envNumber("AUTONOMY_INTERVAL_MS", 2000),
    100,
    60_000,
  );
  const maxSteps = clamp(envNumber("AUTONOMY_MAX_STEPS", 200), 1, 1_000_000);

  const allowedCommands = envString(
    "AUTONOMY_ALLOWED_COMMANDS",
    "ls,pwd,cat,echo,touch,mkdir",
  )
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const character = createCharacter({
    name: "AutonomousLocalAgent",
    bio: "A sandboxed autonomous loop agent that uses local inference and a restricted shell.",
    settings: {
      LLM_MODE: "SMALL",
      CHECK_SHOULD_RESPOND: false,
    },
  });

  logger.info(
    {
      src: "example:autonomous",
      allowedDirectory,
      goalFile,
      stopFile,
      intervalMs,
      maxSteps,
      allowedCommands,
    },
    "Starting sandboxed autonomous loop",
  );

  const runtime = new AgentRuntime({
    character,
    plugins: [inmemorydbPlugin, shellPlugin, localAiPlugin],
    logLevel: "info",
  });
  await runtime.initialize();

  const shellService = runtime.getService<ShellService>("shell");
  if (!shellService) {
    throw new Error("Shell service not available (plugin-shell not loaded?)");
  }

  const userId = uuidv4() as UUID;
  const autonomousRoomId = stringToUuid("autonomous-room");
  const autonomousWorldId = stringToUuid("autonomous-world");

  await runtime.ensureConnection({
    entityId: userId,
    roomId: autonomousRoomId,
    worldId: autonomousWorldId,
    userName: "Autonomy",
    source: "autonomous-loop",
    channelId: "autonomous-room",
    serverId: "autonomous",
    type: ChannelType.DM,
  } as Parameters<typeof runtime.ensureConnection>[0]);

  if (!runtime.messageService) {
    throw new Error("messageService not available on runtime");
  }

  if (!(await exists(goalFile))) {
    const defaultGoal = [
      "Explore the sandbox directory safely.",
      "Create a short STATUS.txt describing what you found.",
      "Keep commands small and only use allowed commands.",
    ].join("\n");
    await fs.writeFile(goalFile, `${defaultGoal}\n`, "utf8");
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    if (await exists(stopFile)) {
      logger.info(
        { src: "example:autonomous", stopFile },
        "STOP file found; exiting",
      );
      break;
    }

    const goal = (await fs.readFile(goalFile, "utf8")).trim();

    const recent = await runtime.getMemories({
      roomId: autonomousRoomId,
      count: 10,
      tableName: AUTONOMY_TABLE,
    });

    const recentSteps = recent
      .slice()
      .reverse()
      .map((m) => (typeof m.content.text === "string" ? m.content.text : ""))
      .filter((t) => t.length > 0)
      .map((t) => truncate(t, 800))
      .join("\n\n---\n\n");

    const prompt = decisionPrompt({
      goal,
      allowedDirectory,
      allowedCommands,
      recentSteps: recentSteps.length > 0 ? recentSteps : "(none yet)",
    });

    const message = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId: autonomousRoomId,
      content: {
        text: prompt,
        source: "autonomous-loop",
        metadata: {
          type: "autonomous-prompt",
          isAutonomous: true,
          channelId: "autonomous",
          timestamp: Date.now(),
        },
      },
    });

    let rawText = "";
    const result = await runtime.messageService.handleMessage(
      runtime,
      message,
      async (content) => {
        if (content?.text) rawText += content.text;
        return [];
      },
    );

    logger.debug(
      {
        src: "example:autonomous",
        step,
        didRespond: result.didRespond,
        mode: result.mode,
      },
      "Message service response",
    );

    const decision = parseDecision(rawText) ?? {
      action: "SLEEP",
      sleepMs: 2000,
      note: "parse-failed",
    };

    const record: StepRecord = {
      step,
      decidedAt: Date.now(),
      goal,
      decision,
    };

    if (decision.action === "RUN") {
      const trimmed = decision.command.trim();
      const allowed = isCommandAllowed(trimmed, allowedCommands);

      if (!allowed) {
        record.shell = {
          executed: false,
          command: trimmed,
          error: "command-not-allowed",
        };
      } else {
        const result = await shellService.executeCommand(
          trimmed,
          autonomousRoomId,
        );
        record.shell = {
          executed: true,
          command: trimmed,
          success: result.success,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout ?? "", 2000),
          stderr: truncate(result.stderr ?? "", 2000),
          executedIn: result.executedIn,
          error: result.error,
        };
      }
    }

    if (decision.action === "SLEEP" || decision.action === "STOP") {
      record.shell = { executed: false };
    }

    const summaryLines: string[] = [];
    summaryLines.push(`[step ${step}] ${decision.action}`);
    if (decision.note) summaryLines.push(`note: ${decision.note}`);
    if (decision.action === "RUN")
      summaryLines.push(`command: ${decision.command}`);
    if (decision.action === "SLEEP")
      summaryLines.push(`sleepMs: ${decision.sleepMs}`);
    if (record.shell?.executed) {
      summaryLines.push(
        `result: success=${String(record.shell.success)} exitCode=${String(record.shell.exitCode)} cwd=${String(
          record.shell.executedIn ?? "",
        )}`,
      );
      if (record.shell.stdout)
        summaryLines.push(`stdout:\n${record.shell.stdout}`);
      if (record.shell.stderr)
        summaryLines.push(`stderr:\n${record.shell.stderr}`);
      if (record.shell.error) summaryLines.push(`error: ${record.shell.error}`);
    } else if (record.shell?.error) {
      summaryLines.push(`shell: not executed (${record.shell.error})`);
    }

    const summaryText = summaryLines.join("\n");
    // Persist record summary to in-memory DB for context.
    await runtime.createMemory(
      {
        id: uuidv4() as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: autonomousRoomId,
        createdAt: Date.now(),
        content: { text: summaryText, source: "autonomous-loop" },
        metadata: {
          type: MemoryType.CUSTOM,
          source: "autonomous-loop",
          scope: "room",
          timestamp: Date.now(),
          tags: ["autonomous", "loop"],
        },
      },
      AUTONOMY_TABLE,
    );

    process.stdout.write(`\n${summaryText}\n`);

    if (decision.action === "STOP") {
      break;
    }

    const sleepFor =
      decision.action === "SLEEP" ? decision.sleepMs : intervalMs;
    await new Promise<void>((resolve) => setTimeout(resolve, sleepFor));
  }

  await runtime.stop();
}

await main();
