/**
 * Runtime bridge: connect the core `VOICE_TURN_OBSERVED` event to the
 * LifeOps `VoiceObserver` (the merge-engine path), and emit
 * `VOICE_ENTITY_BOUND` back so the voice-profile owner can persist the
 * binding.
 *
 * This is the production wiring that was missing: `VoiceObserver` and
 * the merge engine (`EntityStore.observeIdentity`) existed and were
 * tested, but nothing drove them at runtime. A voice/speaker-ID plugin
 * (plugin-local-inference) emits `VOICE_TURN_OBSERVED`; this handler
 * folds the turn into the entity + relationship graph and round-trips
 * the resulting entity id via `VOICE_ENTITY_BOUND`.
 *
 * No plugin imports the other: the only shared surface is the core
 * event seam. If plugin-local-inference is absent the emit is a no-op;
 * if plugin-lifeops is absent the observation simply has no consumer.
 */

import {
  EventType,
  type IAgentRuntime,
  logger,
  type VoiceTurnObservedPayload,
} from "@elizaos/core";
import { LifeOpsRepository } from "../repository.js";
import { VoiceObserver } from "./voice-observer.js";

/**
 * One `VoiceObserver` per runtime so its in-memory pending-relationship
 * queue (the "Jill scenario" cross-utterance state) survives across
 * turns. Keyed weakly so it's collected with the runtime.
 */
const observersByRuntime = new WeakMap<IAgentRuntime, Promise<VoiceObserver>>();

/** Test seam: override how the per-runtime observer is built. */
export type VoiceObserverFactory = (
  runtime: IAgentRuntime,
) => Promise<VoiceObserver>;

let observerFactoryOverride: VoiceObserverFactory | null = null;

export function setVoiceObserverFactory(
  factory: VoiceObserverFactory | null,
): void {
  observerFactoryOverride = factory;
}

function resolveObserver(runtime: IAgentRuntime): Promise<VoiceObserver> {
  const cached = observersByRuntime.get(runtime);
  if (cached) return cached;
  const built = observerFactoryOverride
    ? observerFactoryOverride(runtime)
    : (async () => {
        const repository = new LifeOpsRepository(runtime);
        const [entityStore, relationshipStore] = await Promise.all([
          repository.entityStore(runtime.agentId),
          repository.relationshipStore(runtime.agentId),
        ]);
        return new VoiceObserver({ entityStore, relationshipStore });
      })();
  observersByRuntime.set(runtime, built);
  return built;
}

/**
 * Handler for {@link EventType.VOICE_TURN_OBSERVED}. Folds the turn into
 * the merge engine, then emits {@link EventType.VOICE_ENTITY_BOUND}.
 *
 * Errors are contained at this boundary: a failed ingest must not crash
 * the producer's voice pipeline. We log and return without round-tripping
 * (the producer keeps its profile unbound and can retry on the next turn).
 */
export async function handleVoiceTurnObserved(
  payload: VoiceTurnObservedPayload,
): Promise<void> {
  const { runtime } = payload;
  let entityId: string;
  let wasCreated: boolean;
  let displayName: string | undefined;
  try {
    const observer = await resolveObserver(runtime);
    const result = await observer.ingestTurn({
      turnId: payload.turnId,
      text: payload.text,
      imprintClusterId: payload.imprintClusterId,
      matchConfidence: payload.matchConfidence,
      matchedEntityId: payload.matchedEntityId,
      ...(payload.observedAt ? { observedAt: payload.observedAt } : {}),
      ...(payload.isOwner !== undefined ? { isOwner: payload.isOwner } : {}),
    });
    entityId = result.binding.entityId;
    wasCreated = result.binding.wasCreated;
    displayName = result.binding.resolvedClaimedName ?? undefined;
  } catch (err) {
    logger.error(
      {
        err,
        turnId: payload.turnId,
        imprintClusterId: payload.imprintClusterId,
      },
      "[lifeops] VOICE_TURN_OBSERVED ingest failed",
    );
    return;
  }

  await runtime.emitEvent(EventType.VOICE_ENTITY_BOUND, {
    runtime,
    imprintClusterId: payload.imprintClusterId,
    entityId,
    wasCreated,
    ...(displayName ? { displayName } : {}),
  });
}
