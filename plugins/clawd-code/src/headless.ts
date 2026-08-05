/**
 * Clawd Code — Headless Output (JSONL)
 * Semantic JSONL events for `--format json` headless mode
 * (Adapted from clawd-grok/src/headless/output.ts)
 */

export type HeadlessOutputFormat = "text" | "json";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Semantic JSONL events for headless --format json (Clawd headless style) */
export type HeadlessJsonEvent =
  | { type: "step_start"; sessionID?: string; stepNumber: number; timestamp: number }
  | { type: "text"; sessionID?: string; stepNumber: number; text: string; timestamp: number }
  | { type: "tool_use"; sessionID?: string; stepNumber: number; timestamp: number; toolCall: ToolCall; toolResult: ToolResult; timing?: { startedAt?: number; finishedAt?: number; durationMs?: number } }
  | { type: "step_finish"; sessionID?: string; stepNumber: number; timestamp: number; finishReason: string; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsdTicks?: number } }
  | { type: "error"; sessionID?: string; timestamp: number; error: { category: string; code: string; message: string; retryable: boolean } }
  | { type: "session_start"; sessionID: string; timestamp: number; mode: string; model: string }
  | { type: "session_finish"; sessionID: string; timestamp: number; status: "success" | "error" | "aborted" };

export class HeadlessWriter {
  private format: HeadlessOutputFormat;
  private sessionID?: string;
  private stepNumber = 0;
  private buffer: string = '';

  constructor(format: HeadlessOutputFormat = "text", sessionID?: string) {
    this.format = format;
    this.sessionID = sessionID;
  }

  setSession(id: string): void {
    this.sessionID = id;
  }

  sessionStart(mode: string, model: string): void {
    if (this.format !== "json") return;
    const event: HeadlessJsonEvent = {
      type: "session_start",
      sessionID: this.sessionID || "default",
      timestamp: Date.now(),
      mode,
      model,
    };
    this.writeEvent(event);
  }

  sessionFinish(status: "success" | "error" | "aborted" = "success"): void {
    if (this.format !== "json") return;
    const event: HeadlessJsonEvent = {
      type: "session_finish",
      sessionID: this.sessionID || "default",
      timestamp: Date.now(),
      status,
    };
    this.writeEvent(event);
  }

  stepStart(): number {
    this.stepNumber++;
    if (this.format === "json") {
      this.writeEvent({
        type: "step_start",
        sessionID: this.sessionID,
        stepNumber: this.stepNumber,
        timestamp: Date.now(),
      });
    }
    return this.stepNumber;
  }

  text(text: string): void {
    if (this.format === "text") {
      process.stdout.write(text);
    } else {
      this.writeEvent({
        type: "text",
        sessionID: this.sessionID,
        stepNumber: this.stepNumber,
        text,
        timestamp: Date.now(),
      });
    }
  }

  toolUse(toolCall: ToolCall, toolResult: ToolResult, startedAt?: number, finishedAt?: number): void {
    if (this.format === "text") {
      console.log(`\n[TOOL] ${toolCall.name}(${JSON.stringify(toolCall.args)})`);
      console.log(`[RESULT] ${toolResult.ok ? 'OK' : 'FAIL'}: ${toolResult.output.slice(0, 200)}`);
    } else {
      const timing = (startedAt && finishedAt) ? {
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      } : undefined;
      
      this.writeEvent({
        type: "tool_use",
        sessionID: this.sessionID,
        stepNumber: this.stepNumber,
        timestamp: Date.now(),
        toolCall,
        toolResult,
        timing,
      });
    }
  }

  stepFinish(finishReason: string = "stop", usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsdTicks?: number } = {}): void {
    if (this.format === "json") {
      this.writeEvent({
        type: "step_finish",
        sessionID: this.sessionID,
        stepNumber: this.stepNumber,
        timestamp: Date.now(),
        finishReason,
        usage,
      });
    }
  }

  error(category: string, code: string, message: string, retryable: boolean = false): void {
    if (this.format === "text") {
      console.error(`[ERROR] ${category}/${code}: ${message}`);
    } else {
      this.writeEvent({
        type: "error",
        sessionID: this.sessionID,
        timestamp: Date.now(),
        error: { category, code, message, retryable },
      });
    }
  }

  private writeEvent(event: HeadlessJsonEvent): void {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
}
