/**
 * Shared-runtime REST adapter (mobile chat unblock).
 *
 * A Tier-0 "shared" agent runs in-Worker (run-shared-agent-turn) with NO agent
 * server, so it has no `/api/*` REST surface — only the JSON-RPC bridge
 * (`message.send`) + the SSE stream. The mobile/web chat client, however, speaks
 * the agent-server REST conversation contract (`/api/conversations`,
 * `/api/conversations/:id/messages`, …). This use-case maps that REST contract
 * onto the conversation Durable Object, which owns cache-local execution,
 * billing coordination, and ordered history so a REST client can chat with a
 * shared agent unchanged. The cloud-api route at
 * `.../agents/:agentId/api/[...path]` is a thin caller of these functions.
 *
 * Launch model: one canonical conversation per agent (conversationId ===
 * agentId, bridge roomId === conversationId). The list always has exactly one
 * item, so no conversation index is needed.
 */

import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";
import type { SharedReminderDelivery } from "@elizaos/plugin-scheduling/edge";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError } from "../../api/errors";
import { logger } from "../../utils/logger";
import type { BridgeRequest } from "../eliza-sandbox-bridge";
import { coordinateSharedBridge, coordinateSharedHistory } from "./conversation-coordinator";
import type { SharedAgentCharacter } from "./run-shared-agent-turn";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import type { SharedRuntimeChannel } from "./shared-runtime-channel";
import { type BridgeExecutionContext, sharedRuntimeChatService } from "./shared-runtime-chat";
import {
  parseSharedProviderTimingReceipt,
  type SharedProviderTimingReceipt,
} from "./shared-runtime-timing";

const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;

/** Serialize the privacy-bounded provider receipt into finite Server-Timing metrics. */
export function sharedTurnServerTiming(receipt: SharedProviderTimingReceipt | undefined): string {
  if (!receipt) return "";
  return `shared_model;dur=${receipt.durationMs.toFixed(1)};desc="provider=${receipt.selectedProvider} calls=${receipt.callCount} fallbacks=${receipt.fallbackCount} replayed=${receipt.replayed ? 1 : 0} clamped=${receipt.clamped ? 1 : 0}"`;
}

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
  interrupted?: boolean;
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

/**
 * Route of the one view this tier serves. Hoisted out of the registry entry
 * because `SharedRestViewRegistration.path` is optional, while the navigate ack
 * below must return a definite path — sharing the constant keeps the registry
 * entry and the ack from drifting apart.
 */
const SHARED_CHAT_VIEW_PATH = "/chat";

/** The single builtin chat view a shared agent exposes (a `gui` view). */
const SHARED_CHAT_VIEW: SharedRestViewRegistration = {
  id: "chat",
  label: "Chat",
  viewType: "gui",
  description: "Conversations with your agent, inbound messages from every connector",
  icon: "MessageSquare",
  path: SHARED_CHAT_VIEW_PATH,
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
 * POST .../api/views/:viewId/navigate — the shell's navigation ack. Navigation
 * is client-side routing; the agent-server route only echoes the resolved view
 * so the client can confirm the target exists. A shared agent owns exactly one
 * view (`chat`), so navigating to it acks and anything else is honestly absent
 * — the caller gets `null` and the route 404s, matching `sharedRestViews()`
 * rather than acking a view this tier does not serve.
 */
export function sharedRestViewNavigate(viewId: string): {
  ok: true;
  viewId: string;
  viewPath: string;
  viewType: string;
} | null {
  if (viewId.trim() !== SHARED_CHAT_VIEW.id) return null;
  return {
    ok: true,
    viewId: SHARED_CHAT_VIEW.id,
    viewPath: SHARED_CHAT_VIEW_PATH,
    viewType: SHARED_CHAT_VIEW.viewType,
  };
}

/**
 * POST .../api/conversations/:id/greeting — the opening agent line the chat view
 * requests for an empty conversation.
 *
 * This tier does not generate one. Producing a greeting means running a billed
 * model turn, and inventing static text would put words in the agent's mouth
 * that its character never authored — so neither happens here. The empty-text,
 * `generated: false` shape is NOT a fabricated success: it is the agent server's
 * own representation of "no greeting available", returned verbatim by
 * `ensureConversationGreetingStoredUnlocked()` when no runtime is attached
 * (conversation-routes.ts). The client guards on `if (data.text)` before
 * appending, so an empty greeting renders nothing rather than a blank bubble.
 *
 * Only the canonical conversation (id === agentId) answers; any other id is
 * genuinely absent on this tier and stays a 404 rather than acking a
 * conversation that does not exist.
 */
export function sharedRestGreeting(
  agentId: string,
  agentName: string,
  conversationId: string,
): {
  text: "";
  agentName: string;
  generated: false;
  persisted: false;
} | null {
  if (conversationId.trim() !== canonicalConversationId(agentId)) return null;
  return {
    text: "",
    agentName: agentName || "Eliza",
    generated: false,
    persisted: false,
  };
}

/**
 * GET .../api/runtime/mode — the client's runtime-mode snapshot
 * (ui/src/api/runtime-mode-client.ts → useRuntimeMode()). A Tier-0 agent runs
 * in-Worker in Eliza Cloud, so the honest answer is `cloud`, and it is not a
 * controller for some other remote runtime.
 *
 * This is a correctness fix, not just 404 suppression: the client treats the
 * snapshot as advisory and resolves `null` (any non-2xx) by falling back to
 * LOCAL heuristics — so while this path 404s, a cloud-hosted shared agent's UI
 * reasons about itself as if it were a local runtime. Both values are validated
 * client-side against its `RuntimeMode` / `RuntimeDeploymentRuntime` unions.
 */
export function sharedRestRuntimeMode(): {
  mode: "cloud";
  deploymentRuntime: "cloud";
  isRemoteController: false;
  remoteApiBaseConfigured: false;
} {
  return {
    mode: "cloud",
    deploymentRuntime: "cloud",
    isRemoteController: false,
    remoteApiBaseConfigured: false,
  };
}

/**
 * GET .../api/commands — the universal slash-command catalog
 * (`CommandsCatalogResponse` in @elizaos/shared; read by
 * ui/src/api/client-skills.ts `listCommands`). A Tier-0 agent has no agent
 * server and therefore no command registry to enumerate: the builtin catalog is
 * assembled by the runtime from registered plugin commands, and none of those
 * targets exist here. An empty catalog is the truthful answer for this tier, not
 * a masked load failure — offering commands the shared runtime cannot dispatch
 * would be strictly worse than offering none.
 *
 * Without this the client's `listCommands` rejects on the 404 and logs
 * "Failed to load the slash-command catalog; slash menu will be empty" — the
 * same empty menu, reached through an error path.
 */
export function sharedRestCommands(): { commands: [] } {
  return { commands: [] };
}

/**
 * GET .../api/custom-actions — user-defined custom actions
 * (ui/src/api/client-skills.ts `listCustomActions`, shape
 * `{ actions: CustomActionDef[] }`). Custom actions are persisted per agent
 * runtime; a shared agent has no such store, so the honest answer is none. The
 * full-runtime route returns exactly `{ actions: [] }` when nothing is defined,
 * so this matches the contract the client already handles.
 */
export function sharedRestCustomActions(): { actions: [] } {
  return { actions: [] };
}

/** GET .../api/agent/events — the agent event log the shell's activity surfaces
 * poll (ui/src/api/client-agent.ts). A Tier-0 agent runs stateless per-request
 * in a Worker and keeps no event ring buffer, so there is nothing to report.
 * Mirrors the iOS local-agent kernel's synthesis of this same probe
 * (`ui/src/api/ios-local-agent-kernel.ts` → `{ events: [] }`).
 */
export function sharedRestAgentEvents(): { events: [] } {
  return { events: [] };
}

/**
 * POST .../api/agent/start — the client's startup handshake.
 * A shared agent runs in-Worker with no agent server to boot, so the "start"
 * is a no-op that returns the running status the client expects. This unblocks
 * the desktop cloud-only consumer lane which otherwise hot-loops on 404.
 */
export function sharedRestAgentStart(agentName: string): {
  ok: true;
  status: ReturnType<typeof sharedRestStatus>;
} {
  return {
    ok: true,
    status: sharedRestStatus(agentName),
  };
}

/**
 * GET .../api/stream/settings — streaming/avatar settings for the stream view.
 * A shared agent exposes no stream configuration; `{}` is the empty-settings
 * shape the full runtime returns, and the iOS kernel synthesizes the same.
 * `ok: true` matches the agent-server envelope so the client's avatar probe
 * reads "no avatar configured" instead of warning on a failed load.
 */
export function sharedRestStreamSettings(): {
  ok: true;
  settings: Record<string, never>;
} {
  return { ok: true, settings: {} };
}

/**
 * POST .../api/apps/overlay-presence — the app shell reporting which overlay is
 * on screen. Pure presence telemetry consumed by the app-manager runtime to
 * track the foreground app; a shared agent runs no app manager, so there is no
 * presence to record and no app to name. Acks with the agent-server shape
 * (`{ ok: true, appName: null }`) — `appName: null` states plainly that no
 * overlay app was resolved rather than inventing one.
 */
export function sharedRestOverlayPresence(): { ok: true; appName: null } {
  return { ok: true, appName: null };
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
 *    chunk through the conversation coordinator), there is no
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
 * GET .../api/character — the character the app reads. Reuse the same cache-only
 * character resolver as the shared turn; a linked-character cache miss schedules
 * authoritative hydration under waitUntil and fails retryably instead of reading
 * Postgres in the request.
 */
export async function sharedRestCharacter(
  agent: SharedRuntimeAgent,
  agentName: string,
  executionCtx: BridgeExecutionContext,
): Promise<{ character: SharedAgentCharacter; agentName: string }> {
  const character = await sharedRuntimeChatService.getCharacter(agent, executionCtx);
  return { character, agentName: agentName || "Eliza" };
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
 * history for this room and present it in the REST message shape. New rows use
 * persisted stable ids; legacy rows fall back to their old positional id.
 */
export async function sharedRestMessagesGet(
  agentId: string,
  conversationId: string,
  namespace: RuntimeDurableObjectNamespace,
): Promise<{ messages: SharedRestMessage[] }> {
  const history = await coordinateSharedHistory(agentId, conversationId, { namespace });
  // Lifecycle system events shape model continuity but are not authored chat
  // bubbles, so keep them private to the canonical history/prompt boundary.
  const visibleHistory = history.filter(
    (turn): turn is typeof turn & { role: "user" | "assistant" } =>
      turn.role === "user" || turn.role === "assistant",
  );
  const messages = visibleHistory.map((turn, index) => ({
    id: turn.id ?? `${conversationId}:${index}`,
    role: turn.role,
    text: turn.content,
    timestamp: sharedRestMessageTimestamp(turn, index, visibleHistory.length),
    ...(turn.role === "assistant" && turn.interrupted ? { interrupted: true } : {}),
  }));
  return { messages };
}

/**
 * POST .../api/conversations/:id/messages — forward the user text to the shared
 * bridge `message.send` (which runs the turn, persists history, and bills), then
 * return the assistant reply in the REST send-result shape. A caller-supplied
 * `clientMessageId` becomes the RPC id so a retried send de-dupes against a
 * turn that already landed (#18045); absent, each send gets a fresh id.
 */
export async function sharedRestMessageSend(
  agent: SharedRuntimeAgent,
  conversationId: string,
  text: string,
  agentName: string,
  executionCtx: BridgeExecutionContext,
  namespace: RuntimeDurableObjectNamespace,
  clientMessageId?: string,
  funding: "organization-credits" | "platform" = "organization-credits",
  trustedDelivery?: SharedReminderDelivery,
  trustedUserUtterance?: string,
  trustedChannel?: SharedRuntimeChannel,
): Promise<{ text: string; agentName: string; timing?: SharedProviderTimingReceipt }> {
  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: clientMessageId ?? crypto.randomUUID(),
    method: "message.send",
    // params.clientMessageId marks the id as CLIENT-supplied: only those enter
    // the coordinator's durable claim/replay/conflict boundary (#18045).
    params: {
      text,
      roomId: conversationId,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(trustedDelivery ? { trustedDelivery } : {}),
    },
  };
  // The production coordinator and Worker lifetime are required together so a
  // missing binding cannot select an inline legacy bridge or billing path.
  const response = await coordinateSharedBridge(agent, rpc, {
    executionCtx,
    namespace,
    ...(funding === "platform" ? { agentKind: "personal" as const } : {}),
    ...(trustedUserUtterance ? { trustedUserUtterance } : {}),
    channel: trustedChannel ?? {
      type: ChannelType.DM,
      source: trustedDelivery?.platform ?? MESSAGE_SOURCE_CLIENT_CHAT,
    },
  });
  if (response.error) {
    // A credit-reserve rejection is a permanent add-credits condition, not a
    // transient bridge failure — surface it typed so the route boundary can
    // return the canonical 402 instead of the generic retryable 503.
    if (response.error.code === BRIDGE_INSUFFICIENT_CREDITS_CODE) {
      throw new InsufficientCreditsError(response.error.message);
    }
    throw new Error(response.error.message || "shared message.send failed");
  }
  const result = (response.result ?? {}) as { text?: unknown; timing?: unknown };
  const replyText = typeof result.text === "string" ? result.text : "";
  const timing = parseSharedProviderTimingReceipt(result.timing);
  if (result.timing !== undefined && timing === undefined) {
    logger.warn("[shared-runtime REST] message.send returned an invalid timing receipt", {
      agentId: agent.id,
      conversationId,
    });
  }
  return {
    text: replyText,
    agentName: agentName || "Eliza",
    ...(timing ? { timing } : {}),
  };
}
