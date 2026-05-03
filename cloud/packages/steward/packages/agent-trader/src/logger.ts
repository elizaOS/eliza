/**
 * Structured JSON logger for the agent-trader service.
 *
 * Every line emitted is a self-contained JSON object so that log-shippers,
 * grep, and jq can consume the output without any parsing logic.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface DecisionLog {
  timestamp: string;
  agentId: string;
  strategy: string;
  action: "buy" | "sell" | "hold";
  amount: string;
  reason: string;
  confidence: number;
  dryRun: boolean;
}

export interface SubmissionLog {
  timestamp: string;
  agentId: string;
  txId?: string;
  status: "submitted" | "signed" | "pending_approval" | "rejected" | "error";
  to: string;
  value: string;
  dataLen: number;
  chainId: number;
  error?: string;
}

export interface WebhookLog {
  timestamp: string;
  event: string;
  agentId: string;
  data: Record<string, unknown>;
}

// ─── Internal emit ───────────────────────────────────────────────────────────

function emit(level: LogLevel, tag: string, payload: Record<string, unknown>): void {
  const line = JSON.stringify({ level, tag, ...payload });
  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function logDecision(entry: Omit<DecisionLog, "timestamp">): void {
  emit("info", "decision", { timestamp: new Date().toISOString(), ...entry });
}

export function logSubmission(entry: Omit<SubmissionLog, "timestamp">): void {
  const level: LogLevel =
    entry.status === "error" || entry.status === "rejected" ? "error" : "info";
  emit(level, "submission", { timestamp: new Date().toISOString(), ...entry });
}

export function logWebhook(entry: Omit<WebhookLog, "timestamp">): void {
  emit("info", "webhook", { timestamp: new Date().toISOString(), ...entry });
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  emit("info", "info", {
    timestamp: new Date().toISOString(),
    message,
    ...meta,
  });
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  emit("warn", "warn", {
    timestamp: new Date().toISOString(),
    message,
    ...meta,
  });
}

export function logError(message: string, error?: unknown, meta?: Record<string, unknown>): void {
  const errMeta =
    error instanceof Error
      ? { errorMessage: error.message, stack: error.stack }
      : error
        ? { errorRaw: String(error) }
        : {};
  emit("error", "error", {
    timestamp: new Date().toISOString(),
    message,
    ...errMeta,
    ...meta,
  });
}
