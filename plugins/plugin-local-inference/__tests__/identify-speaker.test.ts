/**
 * Tests for the IDENTIFY_SPEAKER action (issue #8234, shape #2).
 *
 * The action selects the most-recent unidentified speaker profile and
 * drives the merge engine via `VOICE_TURN_OBSERVED`. Here the merge-engine
 * round-trip is simulated by a fake runtime whose `emitEvent` mints an
 * entity id and invokes the real `handleVoiceEntityBound` consumer — so the
 * test exercises the full producer → bind path without loading lifeops.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractSpeakerName,
  identifySpeakerAction,
} from "../src/actions/identify-speaker";
import {
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

function makeMessage(text: string): Memory {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    entityId: "22222222-2222-2222-2222-222222222222",
    roomId: "33333333-3333-3333-3333-333333333333",
    content: { text },
  } as unknown as Memory;
}

/**
 * Fake runtime whose `emitEvent` plays the merge-engine consumer: on a
 * VOICE_TURN_OBSERVED it mints an entity id and runs the real round-trip
 * binding handler.
 */
function makeRuntime(entityId: string): {
  runtime: IAgentRuntime;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  const emitEvent = vi.fn(
    async (type: string, payload: { imprintClusterId: string; text: string }) => {
      if (type === EventType.VOICE_TURN_OBSERVED) {
        await handleVoiceEntityBound({
          runtime: {} as IAgentRuntime,
          imprintClusterId: payload.imprintClusterId,
          entityId,
          displayName: payload.text.replace(/^This is\s+/, "").replace(/\.$/, ""),
        });
      }
    },
  );
  return { runtime: { emitEvent } as unknown as IAgentRuntime, emitEvent };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "identify-speaker-"));
  store = new VoiceProfileStore({ rootDir: tmpRoot });
  await store.init();
  setVoiceEntityBindingStore(store);
});

afterEach(() => {
  setVoiceEntityBindingStore(null);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("extractSpeakerName", () => {
  it.each([
    ["that was Jill", "Jill"],
    ["this is my friend Sam", "Sam"],
    ["call her Alex", "Alex"],
    ["his name is Bob Smith", "Bob Smith"],
    ["the speaker was Dana", "Dana"],
  ])("extracts %s → %s", (input, expected) => {
    expect(extractSpeakerName(input)).toBe(expected);
  });

  it.each(["hello there", "what time is it", ""])(
    "returns null for non-claim %s",
    (input) => {
      expect(extractSpeakerName(input)).toBeNull();
    },
  );
});

describe("identifySpeakerAction", () => {
  it("binds the most-recent unidentified speaker to the named entity", async () => {
    // An already-identified profile must be skipped.
    await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_known",
      entityId: "ent_known",
      confidence: 0.9,
      durationMs: 1500,
    });
    const unknown = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_unknown",
      confidence: 0.5,
      durationMs: 1500,
    });

    const { runtime, emitEvent } = makeRuntime("ent_jill");
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("that was Jill"),
      undefined,
      undefined,
      undefined,
    );

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitEvent.mock.calls[0] as [
      string,
      { imprintClusterId: string; text: string; matchedEntityId: string | null },
    ];
    expect(eventType).toBe(EventType.VOICE_TURN_OBSERVED);
    expect(payload.imprintClusterId).toBe("cluster_unknown");
    expect(payload.text).toBe("This is Jill.");
    expect(payload.matchedEntityId).toBeNull();

    expect(result).toMatchObject({ success: true });
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({
      profileId: unknown.profileId,
      entityId: "ent_jill",
      name: "Jill",
    });
    // The profile is now bound.
    expect((await store.get(unknown.profileId))?.entityId).toBe("ent_jill");
  });

  it("fails cleanly when no name can be resolved", async () => {
    const { runtime, emitEvent } = makeRuntime("ent_x");
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("who was that"),
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ success: false });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("fails cleanly when there is no unidentified recent voice", async () => {
    await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_known",
      entityId: "ent_known",
      confidence: 0.9,
      durationMs: 1500,
    });
    const { runtime, emitEvent } = makeRuntime("ent_x");
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("that was Jill"),
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ success: false });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("honors an explicit profileId option", async () => {
    const a = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_a",
      confidence: 0.5,
      durationMs: 1500,
    });
    await store.createProfile({
      centroid: unit([0, 0, 1, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_b",
      confidence: 0.5,
      durationMs: 1500,
    });

    const { runtime, emitEvent } = makeRuntime("ent_target");
    await identifySpeakerAction.handler!(
      runtime,
      makeMessage("name this voice"),
      undefined,
      { name: "Dana", profileId: a.profileId },
      undefined,
    );
    const [, payload] = emitEvent.mock.calls[0] as [
      string,
      { imprintClusterId: string },
    ];
    expect(payload.imprintClusterId).toBe("cluster_a");
    expect((await store.get(a.profileId))?.entityId).toBe("ent_target");
  });
});
