/**
 * EscalationService — escalates an unacknowledged agent message to the owner
 * across the configured ordered channels (client_chat first, then paired
 * connectors), retrying on a wait/backoff timer until the owner responds or the
 * retry budget is exhausted. State is module-level but partitioned per agent
 * (one active escalation at a time PER AGENT, coalescing new reasons into it)
 * and persisted to the runtime cache under an agent-scoped key so it survives
 * restarts; owner-contact config and routing hints resolve the delivery target
 * per channel. `registerEscalationChannel` appends newly paired channels to the
 * escalation order in eliza.json.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import {
  logger,
  MESSAGE_SOURCE_CLIENT_CHAT,
  requireConfirmedSendHandlerDelivery,
} from "@elizaos/core";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  type OwnerContactRoutingHint,
  resolveOwnerContactWithFallback,
  resolveScopedSendSource,
} from "../config/owner-contacts.ts";
import type {
  EscalationConfig,
  OwnerContactEntry,
  OwnerContactsConfig,
} from "../config/types.agent-defaults.ts";
import { resolveOwnerEntityId } from "../runtime/owner-entity.ts";
import {
  hasRuntimeSendHandler,
  logMissingSendHandlerOnce,
} from "./send-handler-availability.ts";

export interface EscalationState {
  id: string;
  reason: string;
  text: string;
  currentStep: number;
  channelsSent: string[];
  startedAt: number;
  lastSentAt: number;
  resolved: boolean;
  resolvedAt?: number;
}

const DEFAULT_CHANNELS: string[] = [MESSAGE_SOURCE_CLIENT_CHAT];
const DEFAULT_WAIT_MINUTES = 5;
const DEFAULT_MAX_RETRIES = 3;
const ESCALATION_CACHE_KEY_PREFIX = "agent:escalation:active";

/**
 * In-memory escalation state, partitioned by `runtime.agentId`.
 *
 * These maps used to be flat (`escalationId -> state`) while
 * {@link escalationCacheKey} was already agent-scoped. A process that holds
 * more than one runtime — a multi-agent boot (one service instance per runtime
 * over the same data dir) or a runtime rebuilt in-process by PGLite recovery —
 * then shared one "active escalation" across agents: agent B's
 * `startEscalation` found agent A's state, appended B's reason/text to it, and
 * persisted A's mutated state under B's cache key. B never got its own
 * escalation and A's timer went on to deliver text that belonged to B.
 * Partitioning both maps the same way the cache key is partitioned keeps each
 * agent's escalation to itself.
 */
const activeEscalations = new Map<string, Map<string, EscalationState>>();
const pendingTimers = new Map<
  string,
  Map<string, ReturnType<typeof setTimeout>>
>();

function agentIdOf(runtime: IAgentRuntime): string {
  return runtime.agentId as string;
}

function escalationsFor(agentId: string): Map<string, EscalationState> {
  let bucket = activeEscalations.get(agentId);
  if (!bucket) {
    bucket = new Map<string, EscalationState>();
    activeEscalations.set(agentId, bucket);
  }
  return bucket;
}

function timersFor(
  agentId: string,
): Map<string, ReturnType<typeof setTimeout>> {
  let bucket = pendingTimers.get(agentId);
  if (!bucket) {
    bucket = new Map<string, ReturnType<typeof setTimeout>>();
    pendingTimers.set(agentId, bucket);
  }
  return bucket;
}

/**
 * Locate an escalation by id. `resolveEscalation` may be called without a
 * runtime, so fall back to a scan across agents when no runtime is supplied.
 */
function findEscalation(
  escalationId: string,
  runtime?: IAgentRuntime,
): { agentId: string; state: EscalationState } | null {
  if (runtime) {
    const agentId = agentIdOf(runtime);
    const state = activeEscalations.get(agentId)?.get(escalationId);
    return state ? { agentId, state } : null;
  }
  for (const [agentId, bucket] of activeEscalations) {
    const state = bucket.get(escalationId);
    if (state) return { agentId, state };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence helpers -- owned by agent state instead of app-lifeops storage.
// ---------------------------------------------------------------------------

function escalationCacheKey(runtime: IAgentRuntime): string {
  return `${ESCALATION_CACHE_KEY_PREFIX}:${runtime.agentId as string}`;
}

async function persistState(
  runtime: IAgentRuntime,
  state: EscalationState,
): Promise<void> {
  try {
    if (state.resolved) {
      await runtime.deleteCache(escalationCacheKey(runtime));
      return;
    }
    await runtime.setCache(escalationCacheKey(runtime), state);
  } catch (err) {
    logger.debug(
      "[escalation] Failed to persist escalation state to cache",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function loadActiveFromCache(
  runtime: IAgentRuntime,
): Promise<EscalationState | null> {
  try {
    const state = await runtime.getCache<EscalationState>(
      escalationCacheKey(runtime),
    );
    return state ?? null;
  } catch (err) {
    logger.debug(
      "[escalation] Failed to load escalation state from cache",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function loadEscalationConfig(): EscalationConfig {
  try {
    const cfg = loadElizaConfig();
    return cfg.agents?.defaults?.escalation ?? {};
  } catch {
    return {};
  }
}

/**
 * Register a channel in the escalation config's ordered channel list.
 *
 * Called after a connector pairing succeeds so that the escalation service
 * can reach the owner on the newly connected platform without manual
 * configuration. `client_chat` always stays first; new channels are
 * appended in order of pairing.
 *
 * Persists the updated config to `eliza.json` via {@link saveElizaConfig}.
 * Returns `true` if the channel was newly added, `false` if already present.
 */
export function registerEscalationChannel(channelName: string): boolean {
  if (!channelName || typeof channelName !== "string") {
    return false;
  }

  const trimmed = channelName.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const cfg = loadElizaConfig();

    if (!cfg.agents) {
      cfg.agents = {};
    }
    if (!cfg.agents.defaults) {
      cfg.agents.defaults = {};
    }
    if (!cfg.agents.defaults.escalation) {
      cfg.agents.defaults.escalation = {};
    }
    const escalation = cfg.agents.defaults.escalation;

    const existing = Array.isArray(escalation.channels)
      ? [...escalation.channels]
      : [...DEFAULT_CHANNELS];

    if (existing.includes(trimmed)) {
      return false;
    }

    // Ensure client_chat stays first
    if (!existing.includes(MESSAGE_SOURCE_CLIENT_CHAT)) {
      existing.unshift(MESSAGE_SOURCE_CLIENT_CHAT);
    }

    existing.push(trimmed);
    escalation.channels = existing;

    saveElizaConfig(cfg);
    logger.info(
      `[escalation] Registered channel "${trimmed}" -- escalation order: [${existing.join(", ")}]`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[escalation] Failed to register channel "${trimmed}"`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function loadOwnerContacts(): OwnerContactsConfig {
  return loadOwnerContactsConfig({
    boundary: "escalation",
    operation: "owner_contacts_config",
    message:
      "[escalation] Failed to load owner contacts config; escalation delivery has no configured owner channels.",
  });
}

function resolveChannels(config: EscalationConfig): string[] {
  const channels = config.channels;
  return Array.isArray(channels) && channels.length > 0
    ? channels
    : DEFAULT_CHANNELS;
}

/**
 * Channels the escalation can actually deliver on. An explicit operator order
 * always wins. With no configured order the static default is `client_chat`
 * alone — which ghosts a connector-primary owner: the dashboard send throws
 * "no conversation available", every retry re-hits the same channel, and the
 * owner never hears (observed live: a stalled-task escalation retried
 * client_chat 3× while the owner sat in Discord). Extend the unconfigured
 * default with every channel that resolves an owner contact or routing hint,
 * most recent owner response first, so delivery can fall through to a
 * connector that actually reaches the owner.
 */
export function resolveDeliverableChannels(
  config: EscalationConfig,
  ownerContacts: OwnerContactsConfig,
  routingHints: Record<string, OwnerContactRoutingHint>,
): string[] {
  const configured = resolveChannels(config);
  if (Array.isArray(config.channels) && config.channels.length > 0) {
    return configured;
  }
  const known = new Set(configured);
  const hinted = Object.entries(routingHints)
    .filter(([channel, hint]) => !known.has(channel) && hint != null)
    .sort(
      (a, b) =>
        (Date.parse(b[1]?.lastResponseAt ?? "") || 0) -
        (Date.parse(a[1]?.lastResponseAt ?? "") || 0),
    )
    .map(([channel]) => channel);
  for (const channel of hinted) {
    known.add(channel);
  }
  const contactChannels = Object.keys(ownerContacts).filter(
    (channel) => !known.has(channel),
  );
  return [...configured, ...hinted, ...contactChannels];
}

function resolveWaitMs(config: EscalationConfig): number {
  const mins =
    typeof config.waitMinutes === "number" && config.waitMinutes > 0
      ? config.waitMinutes
      : DEFAULT_WAIT_MINUTES;
  return mins * 60_000;
}

function resolveMaxRetries(config: EscalationConfig): number {
  return typeof config.maxRetries === "number" && config.maxRetries > 0
    ? config.maxRetries
    : DEFAULT_MAX_RETRIES;
}

async function sendToChannel(
  runtime: IAgentRuntime,
  channel: string,
  text: string,
  ownerContacts: OwnerContactsConfig,
  routingHints: Record<string, OwnerContactRoutingHint>,
  ownerEntityId: string | null,
): Promise<boolean> {
  const hint = routingHints[channel] ?? null;
  const resolvedContact =
    resolveOwnerContactWithFallback({
      ownerContacts,
      source: channel,
      ownerEntityId,
    }) ??
    (hint
      ? resolveOwnerContactWithFallback({
          ownerContacts,
          source: hint.source,
          ownerEntityId,
        })
      : null);
  const contact: OwnerContactEntry | undefined =
    resolvedContact?.contact ??
    (hint
      ? {
          entityId: hint.entityId ?? undefined,
          channelId: hint.channelId ?? undefined,
          roomId: hint.roomId ?? undefined,
        }
      : undefined);
  if (!contact) {
    logger.warn(
      `[escalation] No owner contact configured for channel "${channel}"`,
    );
    return false;
  }

  try {
    // A contact's explicit `source` wins; otherwise a scoped contact key
    // ("discord-nubs-test") resolves to the registered handler it scopes
    // ("discord") instead of being used verbatim as a send source that no
    // handler serves.
    const targetSource =
      contact.source?.trim() ||
      resolveScopedSendSource(resolvedContact?.source ?? channel, (source) =>
        hasRuntimeSendHandler(runtime, source),
      );
    // Boot-window guard for EVERY source (live: the boot's own
    // service-failure escalation fired before the discord handler registered
    // and the send threw). A missing handler is a skip — escalation's
    // channel/wait retry machinery re-attempts once runtime wiring completes.
    if (!hasRuntimeSendHandler(runtime, targetSource)) {
      logMissingSendHandlerOnce("escalation", targetSource);
      return false;
    }

    requireConfirmedSendHandlerDelivery(
      await runtime.sendMessageToTarget(
        {
          source: targetSource,
          entityId: contact.entityId as UUID | undefined,
          channelId: contact.channelId,
          roomId: contact.roomId as UUID | undefined,
        } as Parameters<typeof runtime.sendMessageToTarget>[0],
        {
          text,
          source: targetSource,
          metadata: {
            urgency: "urgent",
            escalation: true,
            routeSource: targetSource,
            routeResolution: hint?.resolvedFrom,
            routeEndpoint:
              contact.channelId ?? contact.roomId ?? contact.entityId ?? null,
            routeLastResponseAt: hint?.lastResponseAt ?? null,
            routeLastResponseChannel: hint?.lastResponseChannel ?? null,
          },
        },
      ),
    );
    return true;
  } catch (err) {
    // error-policy:J1 escalation delivery boundary returns an explicit false
    // when transport or delivery evidence is unavailable.
    logger.warn(
      `[escalation] Failed to send to channel "${channel}"`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function ownerRespondedSince(
  runtime: IAgentRuntime,
  ownerContacts: OwnerContactsConfig,
  routingHints: Record<string, OwnerContactRoutingHint>,
  ownerEntityId: string | null,
  sinceTimestamp: number,
): Promise<boolean> {
  const entityIds = new Set<string>();
  if (ownerEntityId) {
    entityIds.add(ownerEntityId);
  }
  for (const contact of Object.values(ownerContacts)) {
    if (contact.entityId) entityIds.add(contact.entityId);
  }
  for (const hint of Object.values(routingHints)) {
    if (hint.entityId) entityIds.add(hint.entityId);
  }

  for (const entityId of entityIds) {
    try {
      const rooms = await runtime.getRoomsForParticipant(entityId as UUID);
      if (!rooms || rooms.length === 0) continue;

      const messages = await runtime.getMemoriesByRoomIds({
        roomIds: rooms as UUID[],
        tableName: "messages",
        limit: 20,
      });

      const ownerMessage = messages.find(
        (m) =>
          m.entityId === entityId &&
          m.createdAt != null &&
          m.createdAt > sinceTimestamp,
      );
      if (ownerMessage) return true;
    } catch (err) {
      logger.debug(
        `[escalation] Error checking owner response for entity ${entityId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return false;
}

function scheduleCheck(
  runtime: IAgentRuntime,
  escalationId: string,
  delayMs: number,
): void {
  const timers = timersFor(agentIdOf(runtime));
  const existing = timers.get(escalationId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    timers.delete(escalationId);
    try {
      await EscalationService.checkEscalation(runtime, escalationId);
    } catch (err) {
      logger.error(
        "[escalation] Scheduled check failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, delayMs);

  timers.set(escalationId, timer);
}

let idCounter = 0;

// biome-ignore lint/complexity/noStaticOnlyClass: module-style service API is intentional here
export class EscalationService {
  static async startEscalation(
    runtime: IAgentRuntime,
    reason: string,
    text: string,
  ): Promise<EscalationState> {
    const existing = EscalationService.getActiveEscalationSync(runtime);
    if (existing) {
      existing.reason = `${existing.reason}; ${reason}`;
      existing.text = `${existing.text}\n---\n${text}`;
      logger.info(
        `[escalation] Coalesced into active escalation ${existing.id}`,
      );
      await persistState(runtime, existing);
      return existing;
    }

    const config = loadEscalationConfig();
    const ownerContacts = loadOwnerContacts();
    const routingHints = await loadOwnerContactRoutingHints(
      runtime,
      ownerContacts,
    );
    const channels = resolveDeliverableChannels(
      config,
      ownerContacts,
      routingHints,
    );
    const ownerEntityId = await resolveOwnerEntityId(runtime);
    const waitMs = resolveWaitMs(config);

    idCounter += 1;
    const escalationId = `esc-${Date.now()}-${idCounter}`;
    const now = Date.now();

    const state: EscalationState = {
      id: escalationId,
      reason,
      text,
      currentStep: 0,
      channelsSent: [],
      startedAt: now,
      lastSentAt: now,
      resolved: false,
    };

    escalationsFor(agentIdOf(runtime)).set(escalationId, state);

    // Initial delivery falls through failed channels immediately: a channel
    // whose send throws (dashboard with no conversation, missing handler) is
    // not a delivery, and waiting a full retry interval to try the next one
    // just delays the owner hearing about an already-urgent condition.
    for (const [index, channel] of channels.entries()) {
      const sent = await sendToChannel(
        runtime,
        channel,
        text,
        ownerContacts,
        routingHints,
        ownerEntityId,
      );
      if (sent) {
        state.channelsSent.push(channel);
        state.currentStep = index;
        break;
      }
    }

    const maxRetries = resolveMaxRetries(config);
    if (channels.length > 1 || maxRetries > 1) {
      scheduleCheck(runtime, escalationId, waitMs);
    }

    logger.info(
      `[escalation] Started ${escalationId}: channel=${channels[0]}, reason="${reason}"`,
    );

    await persistState(runtime, state);

    return state;
  }

  static async checkEscalation(
    runtime: IAgentRuntime,
    escalationId: string,
  ): Promise<void> {
    const state = escalationsFor(agentIdOf(runtime)).get(escalationId);
    if (!state || state.resolved) return;

    const config = loadEscalationConfig();
    const ownerContacts = loadOwnerContacts();
    const routingHints = await loadOwnerContactRoutingHints(
      runtime,
      ownerContacts,
    );
    const channels = resolveDeliverableChannels(
      config,
      ownerContacts,
      routingHints,
    );
    const ownerEntityId = await resolveOwnerEntityId(runtime);
    const maxRetries = resolveMaxRetries(config);
    const waitMs = resolveWaitMs(config);

    const responded = await ownerRespondedSince(
      runtime,
      ownerContacts,
      routingHints,
      ownerEntityId,
      state.lastSentAt,
    );

    if (responded) {
      await EscalationService.resolveEscalation(escalationId, runtime);
      return;
    }

    state.currentStep += 1;

    if (state.currentStep >= maxRetries) {
      logger.warn(
        `[escalation] ${escalationId}: max retries (${maxRetries}) reached -- giving up`,
      );
      state.resolved = true;
      state.resolvedAt = Date.now();
      await persistState(runtime, state);
      return;
    }

    const nextChannelIndex = state.currentStep % channels.length;
    const nextChannel = channels[nextChannelIndex];
    if (nextChannel) {
      const sent = await sendToChannel(
        runtime,
        nextChannel,
        state.text,
        ownerContacts,
        routingHints,
        ownerEntityId,
      );
      if (sent) {
        state.channelsSent.push(nextChannel);
      }
      state.lastSentAt = Date.now();
    }

    await persistState(runtime, state);

    if (state.currentStep + 1 < maxRetries) {
      scheduleCheck(runtime, escalationId, waitMs);
    }
  }

  static async resolveEscalation(
    escalationId: string,
    runtime?: IAgentRuntime,
  ): Promise<void> {
    const found = findEscalation(escalationId, runtime);
    if (!found) return;
    const { agentId, state } = found;
    if (state.resolved) return;

    state.resolved = true;
    state.resolvedAt = Date.now();

    const timers = timersFor(agentId);
    const timer = timers.get(escalationId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(escalationId);
    }

    logger.info(`[escalation] Resolved ${escalationId}`);

    if (runtime) {
      await persistState(runtime, state);
    }

    // Drop the resolved escalation from the in-memory map. getActiveEscalationSync
    // ignores resolved entries and the resolved state is persisted to cache, so
    // retaining it only grows the map one entry per escalation ever created.
    const bucket = activeEscalations.get(agentId);
    bucket?.delete(escalationId);
    if (bucket?.size === 0) activeEscalations.delete(agentId);
  }

  /** The calling agent's own active escalation, if any. */
  static getActiveEscalationSync(
    runtime: IAgentRuntime,
  ): EscalationState | null {
    const bucket = activeEscalations.get(agentIdOf(runtime));
    if (!bucket) return null;
    for (const state of bucket.values()) {
      if (!state.resolved) return state;
    }
    return null;
  }

  static async getActiveEscalation(
    runtime: IAgentRuntime,
  ): Promise<EscalationState | null> {
    const cached = EscalationService.getActiveEscalationSync(runtime);
    if (cached) return cached;

    const persisted = await loadActiveFromCache(runtime);
    if (persisted) {
      escalationsFor(agentIdOf(runtime)).set(persisted.id, persisted);
      return persisted;
    }
    return null;
  }

  static async rehydrateFromDb(runtime: IAgentRuntime): Promise<void> {
    const persisted = await loadActiveFromCache(runtime);
    const bucket = escalationsFor(agentIdOf(runtime));
    if (persisted && !bucket.has(persisted.id)) {
      bucket.set(persisted.id, persisted);
      logger.info(
        `[escalation] Rehydrated unresolved escalation ${persisted.id} from cache`,
      );
    }
  }

  static _reset(): void {
    for (const bucket of pendingTimers.values()) {
      for (const timer of bucket.values()) clearTimeout(timer);
    }
    pendingTimers.clear();
    activeEscalations.clear();
    idCounter = 0;
  }

  static async _resetDb(runtime: IAgentRuntime): Promise<void> {
    try {
      await runtime.deleteCache(escalationCacheKey(runtime));
    } catch {
      // Best-effort -- test runtimes may not have a real cache adapter
    }
  }
}
