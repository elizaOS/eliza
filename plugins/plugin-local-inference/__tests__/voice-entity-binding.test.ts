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
  handleVoiceEntityBound,
  setVoiceEntityBindingStore,
} from "../src/runtime/voice-entity-binding";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../src/services/voice/speaker/encoder";

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
