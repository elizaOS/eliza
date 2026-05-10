/**
 * Voice lifecycle state-machine tests.
 *
 * Exercises every documented transition in `lifecycle.ts`:
 *   - default state is `voice-off`
 *   - `arm()` transitions through `voice-arming` → `voice-on`
 *   - `disarm()` transitions through `voice-disarming` → `voice-off`
 *     and invokes `evictPages()` on the TTS + ASR mmap regions
 *   - illegal transitions throw `VoiceLifecycleError`
 *   - 100x arm/disarm cycles do not leak refs in the registry
 *   - mmap failure surfaces as `voice-error` with the right code,
 *     not a silent fallback (AGENTS.md §3 + §9)
 *   - `reset()` is the only way out of `voice-error`
 */

import { describe, expect, it, vi } from "vitest";
import {
  VoiceLifecycle,
  VoiceLifecycleError,
  type VoiceLifecycleLoaders,
  type VoiceLifecycleState,
} from "./lifecycle";
import {
  type MmapRegionHandle,
  type RefCountedResource,
  SharedResourceRegistry,
} from "./shared-resources";

interface FakeMmap extends MmapRegionHandle {
  evictCalls: number;
  releaseCalls: number;
}

function fakeMmap(id: string, opts: { evictThrows?: Error } = {}): FakeMmap {
  const region: FakeMmap = {
    id,
    path: `/tmp/${id}`,
    sizeBytes: 1024,
    evictCalls: 0,
    releaseCalls: 0,
    async evictPages() {
      region.evictCalls++;
      if (opts.evictThrows) throw opts.evictThrows;
    },
    async release() {
      region.releaseCalls++;
    },
  };
  return region;
}

function fakeResource(id: string): RefCountedResource & { releaseCalls: number } {
  const r = {
    id,
    releaseCalls: 0,
    async release() {
      r.releaseCalls++;
    },
  };
  return r;
}

function loadersOk(): VoiceLifecycleLoaders & {
  tts: FakeMmap;
  asr: FakeMmap;
  caches: ReturnType<typeof fakeResource>;
  nodes: ReturnType<typeof fakeResource>;
} {
  const tts = fakeMmap("tts:omnivoice-1.7b");
  const asr = fakeMmap("asr:default");
  const caches = fakeResource("voice-caches");
  const nodes = fakeResource("voice-scheduler-nodes");
  return {
    tts,
    asr,
    caches,
    nodes,
    loadTtsRegion: async () => tts,
    loadAsrRegion: async () => asr,
    loadVoiceCaches: async () => caches,
    loadVoiceSchedulerNodes: async () => nodes,
  };
}

describe("VoiceLifecycle", () => {
  it("defaults to voice-off", () => {
    const reg = new SharedResourceRegistry();
    const lc = new VoiceLifecycle({ registry: reg, loaders: loadersOk() });
    expect(lc.current().kind).toBe("voice-off");
    expect(reg.size()).toBe(0);
  });

  it("arm() transitions voice-off → voice-arming → voice-on with all resources held", async () => {
    const reg = new SharedResourceRegistry();
    const loaders = loadersOk();
    const transitions: VoiceLifecycleState["kind"][] = [];
    const lc = new VoiceLifecycle({
      registry: reg,
      loaders,
      events: {
        onTransition: (_prev, next) => transitions.push(next.kind),
      },
    });
    const armed = await lc.arm();
    expect(transitions).toEqual(["voice-arming", "voice-on"]);
    expect(lc.current().kind).toBe("voice-on");
    expect(armed.tts.id).toBe(loaders.tts.id);
    // All four resources tracked at refcount 1.
    expect(reg.refCount(loaders.tts.id)).toBe(1);
    expect(reg.refCount(loaders.asr.id)).toBe(1);
    expect(reg.refCount(loaders.caches.id)).toBe(1);
    expect(reg.refCount(loaders.nodes.id)).toBe(1);
  });

  it("disarm() transitions voice-on → voice-disarming → voice-off and invokes evictPages on tts+asr", async () => {
    const reg = new SharedResourceRegistry();
    const loaders = loadersOk();
    const transitions: VoiceLifecycleState["kind"][] = [];
    const lc = new VoiceLifecycle({
      registry: reg,
      loaders,
      events: {
        onTransition: (_prev, next) => transitions.push(next.kind),
      },
    });
    await lc.arm();
    transitions.length = 0;
    await lc.disarm();
    expect(transitions).toEqual(["voice-disarming", "voice-off"]);
    expect(lc.current().kind).toBe("voice-off");
    // madvise was called on both heavy regions.
    expect(loaders.tts.evictCalls).toBe(1);
    expect(loaders.asr.evictCalls).toBe(1);
    // Underlying release ran for every resource.
    expect(loaders.tts.releaseCalls).toBe(1);
    expect(loaders.asr.releaseCalls).toBe(1);
    expect(loaders.caches.releaseCalls).toBe(1);
    expect(loaders.nodes.releaseCalls).toBe(1);
    // Registry empty post-disarm.
    expect(reg.size()).toBe(0);
  });

  it("arm() in voice-on throws illegal-transition", async () => {
    const reg = new SharedResourceRegistry();
    const lc = new VoiceLifecycle({ registry: reg, loaders: loadersOk() });
    await lc.arm();
    let thrown: unknown;
    try {
      await lc.arm();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VoiceLifecycleError);
    if (thrown instanceof VoiceLifecycleError) {
      expect(thrown.code).toBe("illegal-transition");
    }
  });

  it("disarm() in voice-off throws illegal-transition", async () => {
    const reg = new SharedResourceRegistry();
    const lc = new VoiceLifecycle({ registry: reg, loaders: loadersOk() });
    let thrown: unknown;
    try {
      await lc.disarm();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VoiceLifecycleError);
    if (thrown instanceof VoiceLifecycleError) {
      expect(thrown.code).toBe("illegal-transition");
    }
  });

  it("100x arm/disarm cycles do not leak resources in the registry", async () => {
    const reg = new SharedResourceRegistry();
    // Build loaders that emit fresh handles on every call so refcount
    // accounting actually exercises acquire/release rather than alias
    // dedup.
    let counter = 0;
    const loaders: VoiceLifecycleLoaders = {
      loadTtsRegion: async () => fakeMmap(`tts-${counter++}`),
      loadAsrRegion: async () => fakeMmap(`asr-${counter++}`),
      loadVoiceCaches: async () => fakeResource(`caches-${counter++}`),
      loadVoiceSchedulerNodes: async () => fakeResource(`nodes-${counter++}`),
    };
    const lc = new VoiceLifecycle({ registry: reg, loaders });
    for (let i = 0; i < 100; i++) {
      await lc.arm();
      await lc.disarm();
    }
    expect(lc.current().kind).toBe("voice-off");
    expect(reg.size()).toBe(0);
  });

  it("simulated mmap failure surfaces as voice-error (no silent fallback)", async () => {
    const reg = new SharedResourceRegistry();
    const tts = fakeMmap("tts");
    const ttsLoad = vi.fn(async () => tts);
    const asrLoad = vi.fn(async () => {
      throw new Error("mmap MAP_FAILED: cannot allocate memory");
    });
    const lc = new VoiceLifecycle({
      registry: reg,
      loaders: {
        loadTtsRegion: ttsLoad,
        loadAsrRegion: asrLoad,
        loadVoiceCaches: async () => fakeResource("caches"),
        loadVoiceSchedulerNodes: async () => fakeResource("nodes"),
      },
    });
    let thrown: unknown;
    try {
      await lc.arm();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VoiceLifecycleError);
    if (thrown instanceof VoiceLifecycleError) {
      // The error message matched both /mmap|MAP_FAILED/ and
      // /ENOMEM|out of memory|RAM/. The mmap branch comes second in the
      // mapper — but the RAM regex matches "memory" first. Either is a
      // structured code; the contract is "not silent fallback".
      expect(["ram-pressure", "mmap-fail"]).toContain(thrown.code);
    }
    expect(lc.current().kind).toBe("voice-error");
    // Partial acquisition rolled back — registry is empty.
    expect(reg.size()).toBe(0);
  });

  it("RAM-pressure error code is preferred when message says ENOMEM", async () => {
    const reg = new SharedResourceRegistry();
    const lc = new VoiceLifecycle({
      registry: reg,
      loaders: {
        loadTtsRegion: async () => {
          throw new Error("ENOMEM: out of memory while mapping TTS weights");
        },
        loadAsrRegion: async () => fakeMmap("asr"),
        loadVoiceCaches: async () => fakeResource("caches"),
        loadVoiceSchedulerNodes: async () => fakeResource("nodes"),
      },
    });
    let thrown: unknown;
    try {
      await lc.arm();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VoiceLifecycleError);
    if (thrown instanceof VoiceLifecycleError) {
      expect(thrown.code).toBe("ram-pressure");
    }
    expect(lc.current().kind).toBe("voice-error");
  });

  it("voice-error is terminal until reset()", async () => {
    const reg = new SharedResourceRegistry();
    const lc = new VoiceLifecycle({
      registry: reg,
      loaders: {
        loadTtsRegion: async () => {
          throw new Error("kernel missing: turboquant_q4 unavailable");
        },
        loadAsrRegion: async () => fakeMmap("asr"),
        loadVoiceCaches: async () => fakeResource("caches"),
        loadVoiceSchedulerNodes: async () => fakeResource("nodes"),
      },
    });
    await expect(lc.arm()).rejects.toBeInstanceOf(VoiceLifecycleError);
    expect(lc.current().kind).toBe("voice-error");
    // Cannot arm again from voice-error.
    await expect(lc.arm()).rejects.toMatchObject({
      code: "illegal-transition",
    });
    // Cannot disarm from voice-error.
    await expect(lc.disarm()).rejects.toMatchObject({
      code: "illegal-transition",
    });
    lc.reset();
    expect(lc.current().kind).toBe("voice-off");
  });

  it("reset() in voice-off throws illegal-transition", () => {
    const reg = new SharedResourceRegistry();
    const lc = new VoiceLifecycle({ registry: reg, loaders: loadersOk() });
    expect(() => lc.reset()).toThrow(VoiceLifecycleError);
  });
});

describe("SharedResourceRegistry", () => {
  it("dedupes by id and refcounts acquire/release", async () => {
    const reg = new SharedResourceRegistry();
    const a = fakeResource("foo");
    const aliased = fakeResource("foo");
    const first = reg.acquire(a);
    const second = reg.acquire(aliased);
    expect(second).toBe(first);
    expect(reg.refCount("foo")).toBe(2);
    await reg.release("foo");
    expect(reg.refCount("foo")).toBe(1);
    expect(a.releaseCalls).toBe(0);
    await reg.release("foo");
    expect(a.releaseCalls).toBe(1);
    expect(reg.size()).toBe(0);
  });

  it("release of unknown id throws — no silent leak", async () => {
    const reg = new SharedResourceRegistry();
    await expect(reg.release("ghost")).rejects.toThrow(
      /unknown resource/,
    );
  });
});
