import { describe, expect, it, vi } from "vitest";

import { createVoiceSessionPlayback } from "../voice-session-playback";
import { FakePlaybackAudioContext } from "./voice-session-fakes";
import { floatPcmToInt16Bytes } from "../voice-session-pcm";

function pcmFrame(value: number, samples: number): Uint8Array {
  return floatPcmToInt16Bytes(new Float32Array(samples).fill(value));
}

describe("voice-session streaming PCM playback sink (ScriptProcessor path)", () => {
  it("uses the ScriptProcessor backend when AudioWorklet is absent", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({ createAudioContext: () => ctx });
    expect(pb.backend).toBe("scriptprocessor");
    await pb.stop();
    expect(ctx.closed).toBe(true);
  });

  it("streams enqueued frames out in ORDER as the engine pulls (no full-clip barrier)", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({ createAudioContext: () => ctx });
    await pb.unlock(); // → running
    // Enqueue two distinguishable frames.
    pb.enqueue(pcmFrame(0.5, 4));
    pb.enqueue(pcmFrame(-0.5, 4));
    const node = ctx.scriptNode!;
    const out = node.render(8); // pull all 8 samples
    // First 4 ≈ 0.5, next 4 ≈ -0.5 → ordering preserved.
    for (let i = 0; i < 4; i += 1) expect(out[i]).toBeCloseTo(0.5, 2);
    for (let i = 4; i < 8; i += 1) expect(out[i]).toBeCloseTo(-0.5, 2);
    await pb.stop();
  });

  it("flush() empties the queue IMMEDIATELY (barge-in) → subsequent pulls are silence", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({ createAudioContext: () => ctx });
    await pb.unlock();
    pb.enqueue(pcmFrame(0.9, 100));
    pb.flush();
    const out = ctx.scriptNode!.render(50);
    expect(out.every((v) => v === 0)).toBe(true);
    await pb.stop();
  });

  it("buffers frames before unlock and drains them on the user-gesture unlock (nothing dropped)", async () => {
    const ctx = new FakePlaybackAudioContext();
    const pb = await createVoiceSessionPlayback({ createAudioContext: () => ctx });
    // Suspended: enqueue must NOT drop; needsUnlock flips true.
    pb.enqueue(pcmFrame(0.5, 4));
    expect(pb.unlocked).toBe(false);
    expect(pb.needsUnlock).toBe(true);
    // A pull before unlock yields silence (nothing running yet), but the frame
    // is retained, not lost.
    await pb.unlock();
    expect(pb.unlocked).toBe(true);
    expect(pb.needsUnlock).toBe(false);
    const out = ctx.scriptNode!.render(4);
    for (let i = 0; i < 4; i += 1) expect(out[i]).toBeCloseTo(0.5, 2);
    await pb.stop();
  });

  it("emits onDrained when the queue transitions from audio to empty", async () => {
    const ctx = new FakePlaybackAudioContext();
    const onDrained = vi.fn();
    const pb = await createVoiceSessionPlayback({
      createAudioContext: () => ctx,
      onDrained,
    });
    await pb.unlock();
    pb.enqueue(pcmFrame(0.5, 2));
    // Pull more than enqueued → transitions to empty → onDrained fires once.
    ctx.scriptNode!.render(8);
    expect(onDrained).toHaveBeenCalledTimes(1);
    await pb.stop();
  });
});
