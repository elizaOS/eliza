/**
 * Tests for the voice ⇄ entity binding seam in plugin-local-inference.
 *
 * `handleVoiceEntityBound` is the runtime path that was missing in issue
 * #8234 — the first real caller of `VoiceProfileStore.bindEntity` outside
 * tests. `emitVoiceTurnObserved` is the producer that drives the merge
 * engine via the core event seam.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitVoiceTurnObserved,
  handleLiveVoiceAttribution,
  handleVoiceEntityBound,
  setVoiceEntityBindingStore,
} from "../src/runtime/voice-entity-binding";
import type { VoiceProfileObservation } from "../src/services/voice/profile-store";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import type { VoiceAttributionOutput } from "../src/services/voice/speaker/attribution-pipeline";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../src/services/voice/speaker/encoder";
import type { VoiceSpeaker } from "../src/services/voice/types";

const MODEL = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;

let tmpRoot: string;
let store: VoiceProfileStore;

function unit(values: number[]): Float32Array {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
  return new Float32Array(values.map((v) => v * inv));
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "voice-entity-binding-"));
  store = new VoiceProfileStore({ rootDir: tmpRoot });
  await store.init();
  setVoiceEntityBindingStore(store);
});

afterEach(() => {
  setVoiceEntityBindingStore(null);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("handleVoiceEntityBound", () => {
  it("persists entityId onto every unbound profile in the cluster", async () => {
    const a = await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_jill",
      confidence: 0.5,
      durationMs: 1500,
    });
    const b = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_jill",
      confidence: 0.5,
      durationMs: 1500,
    });
    // A different cluster must stay untouched.
    const other = await store.createProfile({
      centroid: unit([0, 0, 1, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_other",
      confidence: 0.5,
      durationMs: 1500,
    });

    await handleVoiceEntityBound({
      runtime: {} as IAgentRuntime,
      imprintClusterId: "cluster_jill",
      entityId: "ent_jill",
      displayName: "Jill",
    });

    expect((await store.get(a.profileId))?.entityId).toBe("ent_jill");
    expect((await store.get(b.profileId))?.entityId).toBe("ent_jill");
    expect((await store.get(a.profileId))?.metadata?.label).toBe("Jill");
    expect((await store.get(other.profileId))?.entityId).toBeNull();
  });

  it("is idempotent — already-bound profiles are left alone", async () => {
    const a = await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_jill",
      entityId: "ent_jill",
      confidence: 0.5,
      durationMs: 1500,
    });
    // Second call with the same id must not throw or change anything.
    await handleVoiceEntityBound({
      runtime: {} as IAgentRuntime,
      imprintClusterId: "cluster_jill",
      entityId: "ent_jill",
    });
    expect((await store.get(a.profileId))?.entityId).toBe("ent_jill");
  });
});

describe("emitVoiceTurnObserved", () => {
  it("emits VOICE_TURN_OBSERVED with the mapped payload", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;

    await emitVoiceTurnObserved(runtime, {
      turnId: "turn-1",
      text: "This is Jill.",
      imprintClusterId: "cluster_jill",
      matchConfidence: 1,
      matchedEntityId: null,
      isOwner: false,
      observedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitEvent.mock.calls[0];
    expect(eventType).toBe(EventType.VOICE_TURN_OBSERVED);
    expect(payload).toMatchObject({
      turnId: "turn-1",
      text: "This is Jill.",
      imprintClusterId: "cluster_jill",
      matchConfidence: 1,
      matchedEntityId: null,
      isOwner: false,
      observedAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("defaults turnId and observedAt when omitted", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;

    await emitVoiceTurnObserved(runtime, {
      text: "This is Sam.",
      imprintClusterId: "cluster_sam",
      matchConfidence: 1,
    });

    const [, payload] = emitEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(typeof payload.turnId).toBe("string");
    expect((payload.turnId as string).startsWith("vturn_")).toBe(true);
    expect(typeof payload.observedAt).toBe("string");
    expect(payload.matchedEntityId).toBeNull();
  });
});

// ── handleLiveVoiceAttribution ────────────────────────────────────────────────

/** Build a `VoiceAttributionOutput` for a turn attributed to `entityId`. */
function attributionOutput(args: {
  turnId: string;
  entityId: string | null;
  confidence: number;
  /** When false, omit the observation (no profile match — emit is skipped). */
  withObservation?: boolean;
}): VoiceAttributionOutput {
  const speaker: VoiceSpeaker = {
    id: args.entityId ?? `cluster_${args.turnId}`,
    imprintClusterId: `cluster_${args.turnId}`,
    ...(args.entityId !== null ? { entityId: args.entityId } : {}),
    confidence: args.confidence,
    metadata: { attributionOnly: true },
  };
  const observation: VoiceProfileObservation | null =
    args.withObservation === false
      ? null
      : {
          profileId: `profile_${args.turnId}`,
          imprintClusterId: `cluster_${args.turnId}`,
          entityId: args.entityId,
          embedding: new Float32Array([1, 0, 0, 0]),
          embeddingModel: MODEL,
          confidence: args.confidence,
        };
  return {
    turnId: args.turnId,
    primarySpeaker: speaker,
    segments: [],
    turn: {
      turnId: args.turnId,
      primarySpeaker: speaker,
      segments: [],
    },
    observation,
  };
}

describe("handleLiveVoiceAttribution", () => {
  it("emits VOICE_TURN_OBSERVED and lets the OWNER speak", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "owner",
      entityId: "ent_owner",
      confidence: 0.95,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.95,
    });

    // (a) the observation drove a VOICE_TURN_OBSERVED with isOwner=true.
    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitEvent.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(eventType).toBe(EventType.VOICE_TURN_OBSERVED);
    expect(payload).toMatchObject({
      turnId: "owner",
      imprintClusterId: "cluster_owner",
      matchedEntityId: "ent_owner",
      isOwner: true,
    });

    // (b) the gate signal lets the agent speak and is stamped on the turn.
    expect(signal.agentShouldSpeak).toBe(true);
    expect(signal.nextSpeaker).toBe("agent");
    expect(signal.endOfTurnProbability).toBeCloseTo(0.95);
    expect(output.turn.metadata?.voiceTurnSignal).toBe(signal);
  });

  it("SUPPRESSES a confident bystander who did not say the wake word", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "bystander",
      entityId: "ent_stranger",
      confidence: 0.85, // >= 0.7 → confident
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"], // stranger is NOT enrolled
      endOfTurnProbability: 0.95, // EOT says complete, but bystander wins
    });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(signal.agentShouldSpeak).toBe(false);
    expect(signal.nextSpeaker).toBe("user");
  });

  it("a wake word overrides confident-bystander suppression", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "bystander-wake",
      entityId: "ent_stranger",
      confidence: 0.9,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.95,
      wakeWordActive: true,
    });

    expect(signal.agentShouldSpeak).toBe(true);
    expect(signal.nextSpeaker).toBe("agent");
  });

  it("acoustic self-voice suppresses even when a wake word fired", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "agent-echo",
      entityId: "ent_owner",
      confidence: 0.95,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.95,
      wakeWordActive: true,
      agentSpeaking: true,
      selfVoiceSimilarity: 0.91,
    });

    expect(signal.agentShouldSpeak).toBe(false);
    expect(signal.nextSpeaker).toBe("user");
    expect(
      (signal as { metadata?: { provenance?: string } }).metadata?.provenance,
    ).toBe("voice-bridge+self-voice");
    expect(
      (signal as { metadata?: { selfVoiceSimilarity?: number } }).metadata
        ?.selfVoiceSimilarity,
    ).toBeCloseTo(0.91);
  });

  it("does not apply self-voice similarity when the reply is stale", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "stale-agent-like",
      entityId: "ent_owner",
      confidence: 0.95,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.95,
      replyAgeMs: 60_000,
      selfVoiceSimilarity: 0.95,
    });

    expect(signal.agentShouldSpeak).toBe(true);
    expect(signal.nextSpeaker).toBe("agent");
  });

  it("an UNKNOWN/unbound speaker is NOT suppressed (fail open)", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    // Unbound new cluster: entityId null. Even with high confidence the turn
    // must not be silenced — an uncertain attribution never gates a real turn.
    const output = attributionOutput({
      turnId: "unknown",
      entityId: null,
      confidence: 0.9,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.9,
    });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(signal.agentShouldSpeak).toBe(true);
    expect(signal.nextSpeaker).toBe("agent");
  });

  it("a LOW-confidence bystander is NOT suppressed (below 0.7)", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "low",
      entityId: "ent_stranger",
      confidence: 0.55, // < 0.7 → not confident enough to silence
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.9,
    });

    expect(signal.agentShouldSpeak).toBe(true);
    expect(signal.nextSpeaker).toBe("agent");
  });

  it("a low EOT probability marks nextSpeaker=user even for the owner", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "owner-midclause",
      entityId: "ent_owner",
      confidence: 0.95,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {
      ownerEntityId: "ent_owner",
      knownSpeakerEntityIds: ["ent_owner"],
      endOfTurnProbability: 0.2, // mid-clause → user still talking
    });

    // Owner is allowed to speak in principle, but EOT says they're mid-clause.
    expect(signal.agentShouldSpeak).toBe(true);
    expect(signal.nextSpeaker).toBe("user");
    expect(signal.endOfTurnProbability).toBeCloseTo(0.2);
  });

  it("does NOT emit VOICE_TURN_OBSERVED when there is no observation", async () => {
    const emitEvent = vi.fn(async () => {});
    const runtime = { emitEvent } as unknown as IAgentRuntime;
    const output = attributionOutput({
      turnId: "no-obs",
      entityId: null,
      confidence: 0,
      withObservation: false,
    });

    const signal = await handleLiveVoiceAttribution(runtime, output, {});

    expect(emitEvent).not.toHaveBeenCalled();
    // No speaker gating context → fail open.
    expect(signal.agentShouldSpeak).toBe(true);
    expect(output.turn.metadata?.voiceTurnSignal).toBe(signal);
  });
});
