/**
 * Single-source SSE contract for the chat turn: the phases the agent reports
 * mid-turn and the discriminator it returns when a turn fails. Both the agent
 * server (chat/conversation SSE emission) and the UI client (SSE parsing +
 * render) import these here so the wire format is declared exactly once and the
 * two sides cannot drift (#12409, parent #12093).
 */

/**
 * In-flight assistant-turn status, surfaced to the UI as an additive SSE
 * `{ type: "status", ... }` event so the chat can show what the agent is *doing*
 * rather than just breathing dots. The `token` / `done` / `error` SSE contract
 * is unchanged — a client that ignores `status` events behaves exactly as before.
 *
 * - `thinking`   — the model is being called; no user-visible tokens yet.
 * - `streaming`  — the model is emitting the user-visible reply token-by-token.
 * - `running_action` — a concrete action handler is executing (carry
 *                  `actionName`, e.g. "SEND_MESSAGE").
 * - `running_tool`   — a tool/MCP call is running (carry `toolName`).
 * - `evaluating` — post-response evaluators are running.
 * - `waking`     — a non-running cloud agent is auto-resuming (HTTP 202 +
 *                  Retry-After); the request is parked until it answers.
 * - `speaking`   — the reply is being spoken aloud (voice output); client-derived.
 */
export interface ChatTurnStatus {
  kind:
    | "thinking"
    | "streaming"
    | "running_action"
    | "running_tool"
    | "evaluating"
    | "waking"
    | "speaking";
  /** Optional short human-readable label override for the phase. */
  label?: string;
  /** Canonical action name when `kind === "running_action"`. */
  actionName?: string;
  /** Tool/MCP name when `kind === "running_tool"`. */
  toolName?: string;
}

/**
 * One tool/action-call lifecycle step, surfaced to the UI as an additive SSE
 * `{ type: "tool", ... }` event so the chat thread can render inline tool rows
 * (running → success/failure with arg/result previews) the way Claude Code /
 * Codex do (#13535, follow-up #8813). The runtime's native planner/tool loop
 * already produces these steps and streams them through the same channel as the
 * reply; the chat route forks them onto this event instead of dropping them.
 * Additive: a client that ignores `tool` events behaves exactly as before.
 *
 * - `call`   — the model invoked a tool; `args` carries the input.
 * - `result` — the tool returned; `result` carries the output.
 * - `error`  — the tool failed; `error` carries the message.
 *
 * `callId` correlates a `call` with its later `result`/`error` so the UI can
 * flip one row from running to settled rather than appending a second row.
 */
export interface ChatToolCallEvent {
  phase: "call" | "result" | "error";
  /** Stable id correlating a `call` with its `result`/`error`. */
  callId: string;
  /** Tool/action name being invoked (e.g. "WEB_SEARCH"). */
  toolName: string;
  /** Arguments the model passed to the tool; present on `call`. */
  args?: Record<string, unknown>;
  /** Tool output; present on `result`. */
  result?: unknown;
  /** Failure message; present on `error`. */
  error?: string;
}

/**
 * Discriminator the conversation route includes in its 200 response so the
 * renderer can distinguish "provider configured but throwing" from "no
 * provider configured at all" — the latter is a UX gate ("Connect a
 * provider"), not a chat reply.
 */
export type ChatFailureKind =
  | "insufficient_credits"
  | "no_provider"
  | "provider_issue"
  | "rate_limited"
  | "local_inference";
