import type { ProcessMessageObserver, ProcessMessageStepFinish, ProcessMessageStepStart } from "../agent/agent";
import type { MediaAsset, StreamChunk, ToolCall, ToolResult } from "../types";

export type HeadlessOutputFormat = "text" | "json";

export interface HeadlessWrites {
  stdout?: string;
  stderr?: string;
}

/** Semantic JSONL events for headless `--format json` (OpenCode-style). */
export type HeadlessJsonEvent =
  | {
      type: "step_start";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
    }
  | {
      type: "text";
      sessionID?: string;
      stepNumber: number;
      text: string;
      timestamp: number;
    }
  | {
      type: "tool_use";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      toolCall: ToolCall;
      toolResult: ToolResult;
      /** Present when `onToolStart` / `onToolFinish` observer hooks ran for this tool call. */
      timing?: {
        startedAt?: number;
        finishedAt?: number;
        durationMs?: number;
      };
    }
  | {
      type: "step_finish";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      finishReason: string;
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        costUsdTicks?: number;
      };
    }
  | {
      type: "error";
      sessionID?: string;
      message: string;
      timestamp: number;
    };

export function isHeadlessOutputFormat(value: string): value is HeadlessOutputFormat {
  return value === "text" || value === "json";
}

export function renderHeadlessPrelude(format: HeadlessOutputFormat, sessionId?: string): HeadlessWrites {
  if (format === "json") {
    return {};
  }

  return {
    stdout: "\x1b[36m⏳ Processing...\x1b[0m\n",
    stderr: sessionId ? `\x1b[2mSession: ${sessionId}\x1b[0m\n` : undefined,
  };
}

/**
 * Headless text output only. JSON streaming uses {@link createHeadlessJsonlEmitter} + `Agent.processMessage` observer.
 */
export function renderHeadlessChunk(chunk: StreamChunk): HeadlessWrites {
  switch (chunk.type) {
    case "content":
      return chunk.content ? { stdout: chunk.content } : {};

    case "tool_calls":
      return chunk.toolCalls?.length
        ? {
            stderr: chunk.toolCalls.map((tc: ToolCall) => `\x1b[33m▸ ${formatToolCallLabel(tc)}\x1b[0m\n`).join(""),
          }
        : {};

    case "tool_result": {
      if (!chunk.toolResult) {
        return {};
      }

      const icon = chunk.toolResult.success ? "▸" : "✗";
      const color = chunk.toolResult.success ? "\x1b[32m" : "\x1b[31m";
      const label = chunk.toolCall ? formatToolCallLabel(chunk.toolCall) : "tool";
      const mediaLines =
        chunk.toolResult.media?.map((asset: MediaAsset) => {
          const suffix = asset.url ? ` (${asset.url})` : "";
          return `  ${asset.path}${suffix}`;
        }) ?? [];
      const stderr = [`${color}${icon} ${label}\x1b[0m`, ...mediaLines].join("\n");
      return { stderr: `${stderr}\n` };
    }

    case "error":
      return chunk.content ? { stderr: `\x1b[31m${chunk.content}\x1b[0m\n` } : {};

    case "done":
      return { stdout: "\n" };

    case "reasoning":
      return {};

    default:
      return {};
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatToolCallLabel(tc: ToolCall): string {
  const name = tc.function.name;
  try {
    const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
    if (name === "bash" && typeof args.command === "string") {
      const cmd = args.command.replace(/\n/g, " ").trim();
      return `bash: ${truncate(cmd, 80)}`;
    }
    if (name === "task" && typeof args.agent === "string") {
      const desc = typeof args.description === "string" ? ` — ${args.description}` : "";
      return `task: ${args.agent}${truncate(desc, 60)}`;
    }
    if (name === "read_file" && typeof args.path === "string") {
      return `read: ${args.path}`;
    }
    if ((name === "write_file" || name === "edit_file") && typeof args.path === "string") {
      return `${name === "write_file" ? "write" : "edit"}: ${args.path}`;
    }
  } catch {}
  return name;
}

function jsonLine(event: HeadlessJsonEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Buffers assistant `content` per step and emits JSONL: step_start, text, tool_use, step_finish, error.
 * Pair with `agent.processMessage(prompt, emitter.observer)` in headless JSON mode only.
 *
 * @param sessionId Agent session id (from {@link Agent.getSessionId}) — included on each JSONL line when set.
 */
export function createHeadlessJsonlEmitter(sessionId?: string): {
  observer: ProcessMessageObserver;
  consumeChunk(chunk: StreamChunk): HeadlessWrites;
  /** Call after the `processMessage` iterator completes to flush any trailing observer output. */
  flush(): HeadlessWrites;
} {
  let pending = "";
  let currentStep = 0;
  let textBuffer = "";
  /** Tool call id → timing from {@link ProcessMessageObserver.onToolStart} / {@link ProcessMessageObserver.onToolFinish}. */
  const toolTiming = new Map<string, { startedAt?: number; finishedAt?: number }>();

  function withSession<T extends Record<string, unknown>>(event: T): T & { sessionID?: string } {
    return sessionId ? { ...event, sessionID: sessionId } : event;
  }

  const observer: ProcessMessageObserver = {
    onStepStart(info: ProcessMessageStepStart) {
      currentStep = info.stepNumber;
      textBuffer = "";
      pending += jsonLine(
        withSession({
          type: "step_start",
          stepNumber: info.stepNumber,
          timestamp: info.timestamp,
        }) as HeadlessJsonEvent,
      );
    },
    onStepFinish(info: ProcessMessageStepFinish) {
      if (textBuffer.length > 0) {
        pending += jsonLine(
          withSession({
            type: "text",
            stepNumber: info.stepNumber,
            text: textBuffer,
            timestamp: Date.now(),
          }) as HeadlessJsonEvent,
        );
        textBuffer = "";
      }
      pending += jsonLine(
        withSession({
          type: "step_finish",
          stepNumber: info.stepNumber,
          timestamp: info.timestamp,
          finishReason: info.finishReason,
          usage: info.usage,
        }) as HeadlessJsonEvent,
      );
    },
    onToolStart(info) {
      const prev = toolTiming.get(info.toolCall.id) ?? {};
      toolTiming.set(info.toolCall.id, { ...prev, startedAt: info.timestamp });
    },
    onToolFinish(info) {
      const prev = toolTiming.get(info.toolCall.id) ?? {};
      toolTiming.set(info.toolCall.id, { ...prev, finishedAt: info.timestamp });
    },
  };

  function drainPending(): string {
    const out = pending;
    pending = "";
    return out;
  }

  function flush(): HeadlessWrites {
    const stdout = drainPending();
    return stdout ? { stdout } : {};
  }

  function consumeChunk(chunk: StreamChunk): HeadlessWrites {
    let stdout = drainPending();

    switch (chunk.type) {
      case "content":
        textBuffer += chunk.content ?? "";
        break;

      case "tool_calls": {
        if (textBuffer.length > 0) {
          stdout += jsonLine(
            withSession({
              type: "text",
              stepNumber: currentStep,
              text: textBuffer,
              timestamp: Date.now(),
            }) as HeadlessJsonEvent,
          );
          textBuffer = "";
        }
        break;
      }

      case "tool_result": {
        if (chunk.toolCall && chunk.toolResult) {
          const id = chunk.toolCall.id;
          const timingEntry = toolTiming.get(id);
          toolTiming.delete(id);

          let timing: { startedAt?: number; finishedAt?: number; durationMs?: number } | undefined;
          if (timingEntry) {
            const startedAt = timingEntry.startedAt;
            const finishedAt = timingEntry.finishedAt;
            if (startedAt !== undefined || finishedAt !== undefined) {
              timing = {};
              if (startedAt !== undefined) timing.startedAt = startedAt;
              if (finishedAt !== undefined) timing.finishedAt = finishedAt;
              if (startedAt !== undefined && finishedAt !== undefined) {
                timing.durationMs = finishedAt - startedAt;
              }
            }
          }

          const eventTime = timingEntry?.finishedAt ?? timingEntry?.startedAt ?? Date.now();
          stdout += jsonLine(
            withSession({
              type: "tool_use",
              stepNumber: currentStep,
              timestamp: eventTime,
              toolCall: chunk.toolCall,
              toolResult: chunk.toolResult,
              ...(timing ? { timing } : {}),
            }) as HeadlessJsonEvent,
          );
        }
        break;
      }

      case "error":
        stdout += jsonLine(
          withSession({
            type: "error",
            message: chunk.content ?? "",
            timestamp: Date.now(),
          }) as HeadlessJsonEvent,
        );
        break;

      case "reasoning":
      case "done":
        break;

      default:
        break;
    }

    return stdout ? { stdout } : {};
  }

  return { observer, consumeChunk, flush };
}
