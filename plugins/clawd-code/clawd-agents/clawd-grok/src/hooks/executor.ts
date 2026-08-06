import { spawn } from "child_process";
import type { AggregatedHookResult, CommandHook, HookInput, HookOutput, HookResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const BLOCKING_EXIT_CODE = 2;

/**
 * Execute a single command hook by spawning a shell process.
 * The hook input is piped as JSON to stdin.
 * stdout is parsed as JSON if it starts with '{'.
 * Exit code semantics: 0 = success, 2 = blocking, other = non-blocking error.
 */
export function execCommandHook(
  hook: CommandHook,
  input: HookInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = hook.timeout ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS;
  const jsonInput = JSON.stringify(input);

  return new Promise<HookResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ outcome: "cancelled", exitCode: null, command: hook.command });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const child = spawn("sh", ["-c", hook.command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAWD_HOOK_EVENT: input.hook_event_name },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      finish({
        outcome: "non_blocking_error",
        stderr: err.message,
        exitCode: null,
        command: hook.command,
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? null;
      const output = parseHookOutput(stdout);

      if (exitCode === BLOCKING_EXIT_CODE) {
        finish({
          outcome: "blocking",
          output,
          stderr: stderr.trim(),
          exitCode,
          command: hook.command,
        });
        return;
      }

      if (exitCode !== null && exitCode !== 0) {
        finish({
          outcome: "non_blocking_error",
          output,
          stderr: stderr.trim(),
          exitCode,
          command: hook.command,
        });
        return;
      }

      finish({
        outcome: "success",
        output,
        stderr: stderr.trim() || undefined,
        exitCode: exitCode ?? 0,
        command: hook.command,
      });
    });

    try {
      child.stdin?.write(jsonInput);
      child.stdin?.end();
    } catch {
      /* stdin may already be closed */
    }

    const timeoutTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 3_000);
      finish({
        outcome: "non_blocking_error",
        stderr: `Hook timed out after ${hook.timeout ?? 30}s`,
        exitCode: null,
        command: hook.command,
      });
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      finish({ outcome: "cancelled", exitCode: null, command: hook.command });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Execute an array of hook commands in parallel and aggregate results.
 */
export async function executeHooks(
  hooks: CommandHook[],
  input: HookInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  if (hooks.length === 0) {
    return {
      blocked: false,
      blockingErrors: [],
      preventContinuation: false,
      additionalContexts: [],
      results: [],
    };
  }

  const results = await Promise.all(hooks.map((hook) => execCommandHook(hook, input, cwd, signal)));

  return aggregateResults(results);
}

function aggregateResults(results: HookResult[]): AggregatedHookResult {
  const blockingErrors: Array<{ command: string; stderr: string }> = [];
  const additionalContexts: string[] = [];
  let blocked = false;
  let preventContinuation = false;
  let stopReason: string | undefined;
  let decision: "approve" | "block" | undefined;

  for (const result of results) {
    if (result.outcome === "blocking") {
      blocked = true;
      blockingErrors.push({
        command: result.command,
        stderr: result.stderr ?? "Hook returned exit code 2",
      });
    }

    if (result.output) {
      if (result.output.continue === false) {
        preventContinuation = true;
        stopReason = result.output.stopReason ?? stopReason;
      }
      if (result.output.decision === "block") {
        blocked = true;
        decision = "block";
      } else if (result.output.decision === "approve" && !blocked) {
        decision = "approve";
      }
      if (result.output.additionalContext) {
        additionalContexts.push(result.output.additionalContext);
      }
    }
  }

  return {
    blocked,
    blockingErrors,
    preventContinuation,
    stopReason,
    additionalContexts,
    decision,
    results,
  };
}

function parseHookOutput(stdout: string): HookOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const output: HookOutput = {};
    if (typeof parsed.continue === "boolean") output.continue = parsed.continue;
    if (typeof parsed.stopReason === "string") output.stopReason = parsed.stopReason;
    if (parsed.decision === "approve" || parsed.decision === "block") output.decision = parsed.decision;
    if (typeof parsed.reason === "string") output.reason = parsed.reason;
    if (typeof parsed.additionalContext === "string") output.additionalContext = parsed.additionalContext;

    return Object.keys(output).length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
