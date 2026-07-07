/**
 * Shared-runtime REST adapter (mobile chat unblock).
 *
 * A Tier-0 "shared" agent runs in-Worker (run-shared-agent-turn) with NO agent
 * server, so it has no `/api/*` REST surface — only the JSON-RPC bridge
 * (`message.send`) + the SSE stream. The mobile/web chat client, however, speaks
 * the agent-server REST conversation contract (`/api/conversations`,
 * `/api/conversations/:id/messages`, …). This use-case maps that REST contract
 * onto the existing, proven shared-runtime primitives (the bridge engine, its
 * billing, and its KV turn-history) so a REST client can chat with a shared
 * agent unchanged. The cloud-api route at
 * `.../agents/:agentId/api/[...path]` is a thin caller of these functions.
 *
 * Launch model: ONE canonical conversation per agent (conversationId === agentId,
 * bridge roomId === conversationId). The list always has exactly one item, so no
 * conversation index is needed — every turn lands in the same KV channel the
 * bridge already writes.
 */

import { InsufficientCreditsError } from "../../api/errors";
import type { BridgeRequest } from "../eliza-sandbox";
// Namespace import (resolved at call-time, not captured at module-eval) so the
// adapter always reads the *current* eliza-sandbox export. Under bun's
// process-global `mock.module`, a sibling test file can import this module
// first and bind a captured `{ elizaSandboxService }` to a different (or real)
// service before shared-rest-adapter.test.ts installs its own mock — which on
// Windows surfaced as "elizaSandboxService.bridge is an instance of Promise".
// Reading `elizaSandbox.elizaSandboxService` lazily makes the binding immune to
// that import-order/module-cache race.
import * as elizaSandbox from "../eliza-sandbox";
import type { SharedAgentCharacter } from "./run-shared-agent-turn";

/** Minimal subset of the agent-server REST `Conversation` the chat client reads. */
export interface SharedRestConversation {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  /**
   * The client's `isConversationRecord()` guard REQUIRES `updatedAt` — without
   * it the record is rejected, so there is no active conversation and every send
   * is silently dropped. A shared agent's canonical conversation is never
   * renamed/moved, so `updatedAt` === `createdAt`.
   */
  updatedAt: string;
}

/** Minimal subset of the agent-server REST `ConversationMessage`. */
export interface SharedRestMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

/** The canonical (single) conversation id for a shared agent === its agent id. */
function canonicalConversationId(agentId: string): string {
  return agentId;
}

function makeConversation(
  agentId: string,
  agentName: string,
  createdAt: string,
): SharedRestConversation {
  const id = canonicalConversationId(agentId);
  // updatedAt === createdAt: the canonical conversation is never renamed/moved.
  return { id, title: agentName || "Chat", roomId: id, createdAt, updatedAt: createdAt };
}

/** GET .../api/health — the agent is in-Worker; if it resolves, it's up. */
export function sharedRestHealth(): { status: "ok" } {
  return { status: "ok" };
}

/**
 * GET .../api/status — the startup-coordinator's FIRST hard gate: it calls
 * `getStatus()` before anything else and bails unless `state === "running"`.
 * A shared agent runs in-Worker, so if this resolves it is by definition up.
 *
 * `canRespond` is load-bearing too: the composer's send-gate is
 * `canRespond ?? (running && model)`, and a shared agent has no LOCAL model
 * (inference is hosted in-Worker), so without it the box would stay disabled.
 */
export function sharedRestStatus(agentName: string): {
  state: "running";
  agentName: string;
  canRespond: true;
} {
  return { state: "running", agentName: agentName || "Eliza", canRespond: true };
}

// ---------------------------------------------------------------------------
// Shell-endpoint defaults (mobile/web startup-coordinator unblock)
// ---------------------------------------------------------------------------
//
// A shared agent has no agent server, so it serves NONE of the shell endpoints
// the app's startup-coordinator probes after conversations/messages already
// 200: GET /api/first-run/status, GET /api/first-run, GET /api/views,
// GET /api/config. Without them every probe 404s and the app never boots into
// chat. These functions synthesize the "already-provisioned, no setup needed"
// answers the coordinator expects so a shared agent boots straight into chat.
//
// Contracts mirrored verbatim from the agent server:
//   first-run/status → packages/agent/src/api/first-run-routes.ts
//                      (cloud container branch: { complete, cloudProvisioned })
//   views            → packages/agent/src/api/views-routes.ts (`{ views }`) +
//                      the builtin chat entry from
//                      packages/agent/src/api/builtin-views.ts +
//                      registerBuiltinViews() in views-registry.ts
//   config           → packages/agent/src/api/config-routes.ts (open-ended object)

/** Minimal subset of the agent-server `ViewRegistryEntry` the chat client reads. */
interface SharedRestViewRegistration {
  id: string;
  label: string;
  viewType: "gui" | "tui" | "xr";
  description?: string;
  icon?: string;
  path?: string;
  available: boolean;
  pluginName: string;
  tags?: string[];
  visibleInManager?: boolean;
  desktopTabEnabled?: boolean;
  builtin: boolean;
  hasHeroImage?: boolean;
}

/**
 * GET .../api/first-run/status — a shared agent is cloud-provisioned and never
 * runs first-run, so it is always "complete". Mirrors the cloud-container branch
 * in first-run-routes.ts that responds `{ complete: true, cloudProvisioned: true }`.
 */
export function sharedRestFirstRunStatus(): {
  complete: true;
  cloudProvisioned: true;
} {
  return { complete: true, cloudProvisioned: true };
}

/**
 * GET .../api/first-run — "no setup needed". The app only fetches first-run
 * options when status reports incomplete; for a shared agent that never happens,
 * but return a benign already-complete payload so any probe degrades gracefully.
 */
export function sharedRestFirstRun(): { complete: true; ok: true } {
  return { complete: true, ok: true };
}

/**
 * POST .../api/first-run — onboarding "submit". A shared agent has no config to
 * persist, so this is a harmless no-op that echoes the agent-server success
 * shape (`{ ok: true }`) instead of 404'ing onboarding.
 */
export function sharedRestFirstRunSubmit(): { ok: true } {
  return { ok: true };
}

/** The single builtin chat view a shared agent exposes (a `gui` view). */
const SHARED_CHAT_VIEW: SharedRestViewRegistration = {
  id: "chat",
  label: "Chat",
  viewType: "gui",
  description: "Conversations with your agent, inbound messages from every connector",
  icon: "MessageSquare",
  path: "/chat",
  available: true,
  pluginName: "@elizaos/builtin",
  tags: ["messaging", "conversation", "agent"],
  visibleInManager: true,
  desktopTabEnabled: true,
  builtin: true,
  hasHeroImage: false,
};

/**
 * GET .../api/views — the shell's view registry. A shared agent ships only the
 * single builtin chat view so the app boots into a working chat surface. Shape
 * matches GET /api/views (`{ views: ViewRegistryEntry[] }`); the chat entry is
 * the builtin-views.ts "chat" declaration as registerBuiltinViews() annotates it
 * (pluginName "@elizaos/builtin", builtin:true, available:true).
 *
 * Honors `?viewType=` like the agent server: a request for a non-`gui` surface
 * (e.g. `tui`/`xr`) correctly returns an empty list rather than the gui chat
 * view, so the client's per-view-type probes get an honest answer.
 */
export function sharedRestViews(viewType?: string): {
  views: SharedRestViewRegistration[];
} {
  const requested = viewType?.trim();
  if (requested && requested !== SHARED_CHAT_VIEW.viewType) {
    return { views: [] };
  }
  return { views: [SHARED_CHAT_VIEW] };
}

/**
 * GET .../api/config — the dashboard's open-ended agent config. A shared agent
 * exposes no editable config through this adapter, but it DOES declare its
 * transport capabilities so the client adapts by negotiation instead of
 * URL-sniffing the agent base. A Tier-0 agent runs in a stateless Worker with no
 * persistent process, so it has:
 *  - `websocket: false` — no per-agent socket to connect; the client skips the
 *    WS (avoiding the doomed reconnect loop + "Lost backend connection" overlay
 *    that otherwise paints over a working chat).
 *  - `streaming: false` — kept conservative. A shared agent runs its turn in a
 *    single in-Worker call (no token-by-token generation), so even though
 *    `/messages/stream` IS now reachable (it emits the full reply as one SSE
 *    chunk via bridgeStream — see the messages/stream route), there is no
 *    incremental token stream to gain. Declaring `false` keeps the client on the
 *    non-stream `POST .../messages` (which returns the full reply) cleanly; flip
 *    to `true` only once the shared turn emits real token chunks.
 * The client still reads the rest of the object defensively (`ui`/`cloud`) and
 * falls back. These flags let the app delete its per-base special-casing.
 */
export function sharedRestConfig(): { websocket: false; streaming: false } {
  return { websocket: false, streaming: false };
}

/**
 * GET .../api/auth/me — the app's HARD startup gate (App.tsx auth gate →
 * useAuthStatus → authMe(), ui/src/api/auth-client.ts). A shared agent has no
 * agent server and no owner-password flow; it is reached purely through the
 * caller's authenticated API key, which the route already validated
 * (resolveSharedAgent → requireUserOrApiKeyWithOrg). So the caller is, by
 * construction, an authed machine identity — return it in the agent-server's
 * `bearer-agent` shape (auth-routes.ts authorized branch: identity.kind
 * "machine", session machine with no expiry, access mode "bearer"). Without an
 * `ok:true` body here, the client maps the 404 to status 503 →
 * "server_unavailable" → StartupFailureView and never reaches chat. The identity
 * is the agent itself (id = agentId, displayName = agentName) — the only stable
 * identity this adapter owns.
 */
export function sharedRestAuthMe(
  agentId: string,
  agentName: string,
): {
  identity: { id: string; displayName: string; kind: "machine" };
  session: { id: string; kind: "machine"; expiresAt: null };
  access: { mode: "bearer"; passwordConfigured: false; ownerConfigured: false };
} {
  return {
    identity: {
      id: agentId,
      displayName: agentName || "Eliza",
      kind: "machine",
    },
    session: { id: "bearer", kind: "machine", expiresAt: null },
    access: { mode: "bearer", passwordConfigured: false, ownerConfigured: false },
  };
}

/**
 * GET .../api/character — the character the app reads (getCharacter() →
 * `{ character, agentName }`, character-routes.ts GET /api/character). Reuse the
 * EXACT character the shared turn answers as: getSharedRuntimeCharacter resolves
 * the same `SharedAgentCharacter` buildSharedRuntimeCharacter feeds into
 * message.send. Falls back to an empty character object (the agent server's
 * "no runtime" branch shape) if the sandbox can't be resolved.
 */
export async function sharedRestCharacter(
  agentId: string,
  orgId: string,
  agentName: string,
): Promise<{ character: SharedAgentCharacter | Record<string, never>; agentName: string }> {
  const character = await elizaSandbox.elizaSandboxService.getSharedRuntimeCharacter(
    agentId,
    orgId,
  );
  return { character: character ?? {}, agentName: agentName || "Eliza" };
}

/** GET .../api/conversations — always the one canonical conversation. */
export function sharedRestConversationsList(
  agentId: string,
  agentName: string,
  createdAt: string,
): { conversations: SharedRestConversation[] } {
  return { conversations: [makeConversation(agentId, agentName, createdAt)] };
}

/** POST .../api/conversations — returns the canonical conversation (idempotent). */
export function sharedRestConversationCreate(
  agentId: string,
  agentName: string,
  createdAt: string,
): { conversation: SharedRestConversation } {
  return { conversation: makeConversation(agentId, agentName, createdAt) };
}

/**
 * PATCH .../api/conversations/:id — shared-runtime agents expose one canonical
 * conversation and have no agent-server-side conversation index to mutate.
 * Accept title updates as a compatibility no-op so the app's background title
 * generation does not fail CORS on shared cloud agents.
 */
export function sharedRestConversationUpdate(
  agentId: string,
  agentName: string,
  createdAt: string,
  patch?: { title?: unknown } | null,
): { conversation: SharedRestConversation } {
  const title =
    typeof patch?.title === "string" && patch.title.trim() ? patch.title.trim() : agentName;
  return { conversation: makeConversation(agentId, title, createdAt) };
}

/**
 * DELETE .../api/conversations/:id — deleting the canonical shared-runtime
 * conversation is a no-op because it is derived from the agent identity.
 */
export function sharedRestConversationDelete(): { ok: true } {
  return { ok: true };
}

function sharedRestMessageTimestamp(
  turn: { createdAt?: unknown },
  index: number,
  total: number,
): number {
  if (typeof turn.createdAt === "number" && Number.isFinite(turn.createdAt) && turn.createdAt > 0) {
    return turn.createdAt;
  }
  // Legacy shared-runtime history rows predate createdAt. Keep them finite but
  // safely older than the UI's "just sent" reconciliation window, so a repeated
  // failed send is still restored instead of being masked by an old same-text row.
  return Date.now() - 5 * 60_000 - (total - index);
}

/**
 * GET .../api/conversations/:id/messages — read the bridge's persisted turn
 * history for this room and present it in the REST message shape. Ids are
 * positional+stable (the history is an ordered append-only list).
 */
export async function sharedRestMessagesGet(
  agentId: string,
  conversationId: string,
): Promise<{ messages: SharedRestMessage[] }> {
  const history = await elizaSandbox.elizaSandboxService.getSharedConversationHistory(
    agentId,
    conversationId,
  );
  const messages = history.map((turn, index) => ({
    id: `${conversationId}:${index}`,
    role: turn.role,
    text: turn.content,
    timestamp: sharedRestMessageTimestamp(turn, index, history.length),
  }));
  return { messages };
}

/**
 * POST .../api/conversations/:id/messages — forward the user text to the shared
 * bridge `message.send` (which runs the turn, persists history, and bills), then
 * return the assistant reply in the REST send-result shape.
 */
export async function sharedRestMessageSend(
  agentId: string,
  orgId: string,
  conversationId: string,
  text: string,
  agentName: string,
): Promise<{ text: string; agentName: string }> {
  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message.send",
    params: { text, roomId: conversationId },
  };
  const response = await elizaSandbox.elizaSandboxService.bridge(agentId, orgId, rpc);
  if (response.error) {
    // A credit-reserve rejection is a permanent add-credits condition, not a
    // transient bridge failure — surface it typed so the route boundary can
    // return the canonical 402 instead of the generic retryable 503.
    if (response.error.code === elizaSandbox.BRIDGE_INSUFFICIENT_CREDITS_CODE) {
      throw new InsufficientCreditsError(response.error.message);
    }
    throw new Error(response.error.message || "shared message.send failed");
  }
  const result = (response.result ?? {}) as { text?: unknown };
  const replyText = typeof result.text === "string" ? result.text : "";
  return { text: replyText, agentName: agentName || "Eliza" };
}
