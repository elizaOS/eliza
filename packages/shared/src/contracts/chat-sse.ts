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

/**
 * The discrete phases an in-flight assistant turn moves through, surfaced to the
 * UI so the chat shows what the agent is *doing* (not just breathing dots).
 *
 * - `thinking`   — the turn started; the model is being prompted but no visible
 *                  text has streamed yet.
 * - `streaming`  — the model is emitting the user-visible reply token-by-token.
 * - `running_action` — a concrete action handler is executing (carry
 *                  `actionName`, e.g. "SEND_MESSAGE").
 * - `running_tool`   — a tool/MCP call is running (carry `toolName`).
 * - `evaluating` — post-response evaluators are running.
 * - `waking`     — a non-running cloud agent is auto-resuming (HTTP 202 +
 *                  Retry-After); the request is parked until it answers.
 * - `speaking`   — the reply is being spoken aloud (voice output); client-derived.
 *
 * Emitted by the server as additive SSE `{ type: "status", ... }` events and/or
 * derived client-side. The `token` / `done` / `error` SSE contract is unchanged.
 * A client that ignores `status` events behaves exactly as before.
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
