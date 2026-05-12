import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  type OwnerContactRoutingHint,
  resolveOwnerContactWithFallback,
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

const DEFAULT_CHANNELS: string[] = ["client_chat"];
const DEFAULT_WAIT_MINUTES = 5;
const DEFAULT_MAX_RETRIES = 3;
const ESCALATION_CACHE_KEY_PREFIX = "agent:escalation:active";

const activeEscalations = new Map<string, EscalationState>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      (cfg as Record<string, unknown>).agents = {};
    }
    const agents = cfg.agents as Record<string, unknown>;
    if (!agents.defaults) {
      agents.defaults = {};
    }
    const defaults = agents.defaults as Record<string, unknown>;
    if (!defaults.escalation) {
      defaults.escalation = {};
    }
    const escalation = defaults.escalation as Record<string, unknown>;

    const existing = Array.isArray(escalation.channels)
      ? (escalation.channels as string[])
      : [...DEFAULT_CHANNELS];

    if (existing.includes(trimmed)) {
      return false;
    }

    // Ensure client_chat stays first
    if (!existing.includes("client_chat")) {
      existing.unshift("client_chat");
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
    const targetSource = resolvedContact?.source ?? channel;
    if (
      targetSource === "client_chat" &&
      !hasRuntimeSendHandler(runtime, targetSource)
    ) {
      logMissingSendHandlerOnce("escalation", targetSource);
      return false;
    }

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
          routeResolution: hint?.resolvedFrom ?? "config",
          routeEndpoint:
            contact.channelId ?? contact.roomId ?? contact.entityId ?? null,
          routeLastResponseAt: hint?.lastResponseAt ?? null,
          routeLastResponseChannel: hint?.lastResponseChannel ?? null,
        },
      },
    );
    return true;
  } catch (err) {
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
  const existing = pendingTimers.get(escalationId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    pendingTimers.delete(escalationId);
    try {
      await EscalationService.checkEscalation(runtime, escalationId);
    } catch (err) {
      logger.error(
        "[escalation] Scheduled check failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, delayMs);

  pendingTimers.set(escalationId, timer);
}

let idCounter = 0;

// biome-ignore lint/complexity/noStaticOnlyClass: module-style service API is intentional here
export class EscalationService {
  static async startEscalation(
    runtime: IAgentRuntime,
    reason: string,
    text: string,
  ): Promise<EscalationState> {
    const existing = EscalationService.getActiveEscalationSync();
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
    const channels = resolveChannels(config);
    const ownerContacts = loadOwnerContacts();
    const routingHints = await loadOwnerContactRoutingHints(
      runtime,
      ownerContacts,
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

    activeEscalations.set(escalationId, state);

    const firstChannel = channels[0];
    if (firstChannel) {
      const sent = await sendToChannel(
        runtime,
        firstChannel,
        text,
        ownerContacts,
        routingHints,
        ownerEntityId,
      );
      if (sent) {
        state.channelsSent.push(firstChannel);
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
    const state = activeEscalations.get(escalationId);
    if (!state || state.resolved) return;

    const config = loadEscalationConfig();
    const channels = resolveChannels(config);
    const ownerContacts = loadOwnerContacts();
    const routingHints = await loadOwnerContactRoutingHints(
      runtime,
      ownerContacts,
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
    const state = activeEscalations.get(escalationId);
    if (!state || state.resolved) return;

    state.resolved = true;
    state.resolvedAt = Date.now();

    const timer = pendingTimers.get(escalationId);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(escalationId);
    }

    logger.info(`[escalation] Resolved ${escalationId}`);

    if (runtime) {
      await persistState(runtime, state);
    }
  }

  static getActiveEscalationSync(): EscalationState | null {
    for (const state of activeEscalations.values()) {
      if (!state.resolved) return state;
    }
    return null;
  }

  static async getActiveEscalation(
    runtime: IAgentRuntime,
  ): Promise<EscalationState | null> {
    const cached = EscalationService.getActiveEscalationSync();
    if (cached) return cached;

    const persisted = await loadActiveFromCache(runtime);
    if (persisted) {
      activeEscalations.set(persisted.id, persisted);
      return persisted;
    }
    return null;
  }

  static async rehydrateFromDb(runtime: IAgentRuntime): Promise<void> {
    const persisted = await loadActiveFromCache(runtime);
    if (persisted && !activeEscalations.has(persisted.id)) {
      activeEscalations.set(persisted.id, persisted);
      logger.info(
        `[escalation] Rehydrated unresolved escalation ${persisted.id} from cache`,
      );
    }
  }

  static _reset(): void {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
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
