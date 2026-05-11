import { describe, expect, it } from "vitest";
import { MemoryMonitor } from "./memory-monitor";
import {
  createEvictableModelRole,
  type ResidentModelRole,
  SharedResourceRegistry,
} from "./voice/shared-resources";

const MB = 1024 * 1024;

/** A controllable evictable role for the eviction-order tests. */
function fakeRole(
  role: ResidentModelRole,
  estimatedMb: number,
): {
  resource: ReturnType<typeof createEvictableModelRole>;
  evictCount: () => number;
  reload: () => void;
} {
  let resident = true;
  let evictions = 0;
  const resource = createEvictableModelRole({
    id: `fake:${role}`,
    role,
    estimatedMb,
    isResident: () => resident,
    evict: async () => {
      resident = false;
      evictions += 1;
    },
  });
  return {
    resource,
    evictCount: () => evictions,
    reload: () => {
      resident = true;
    },
  };
}

function monitorWithFreeMb(
  registry: SharedResourceRegistry,
  freeMb: number,
  totalMb = 16 * 1024,
): MemoryMonitor {
  return new MemoryMonitor({
    registry,
    config: { lowWaterMb: 768, lowWaterFraction: 0.08, evictionCooldownMs: 0 },
    sources: {
      osMemory: () => ({ freeBytes: freeMb * MB, totalBytes: totalMb * MB }),
      serverRssMb: async () => null,
    },
  });
}

describe("MemoryMonitor", () => {
  it("does nothing while free RAM is above the low-water line", async () => {
    const registry = new SharedResourceRegistry();
    const text = fakeRole("text-target", 2000);
    registry.acquire(text.resource);
    const monitor = monitorWithFreeMb(registry, 8 * 1024); // plenty free
    const action = await monitor.tick();
    expect(action.evicted).toBeNull();
    expect(action.exhausted).toBe(false);
    expect(text.evictCount()).toBe(0);
  });

  it("under pressure, evicts the lowest-priority resident role first", async () => {
    const registry = new SharedResourceRegistry();
    const drafter = fakeRole("drafter", 800);
    const tts = fakeRole("tts", 300);
    const text = fakeRole("text-target", 4000);
    // Register out of priority order on purpose.
    registry.acquire(text.resource);
    registry.acquire(tts.resource);
    registry.acquire(drafter.resource);
    const monitor = monitorWithFreeMb(registry, 200); // hard pressure

    const first = await monitor.tick();
    expect(first.evicted?.role).toBe("drafter");
    expect(drafter.evictCount()).toBe(1);
    expect(tts.evictCount()).toBe(0);
    expect(text.evictCount()).toBe(0);

    // Still under pressure → next-lowest (tts) goes.
    const second = await monitor.tick();
    expect(second.evicted?.role).toBe("tts");
    expect(tts.evictCount()).toBe(1);
    expect(text.evictCount()).toBe(0);

    // Then the text target — the last thing to go.
    const third = await monitor.tick();
    expect(third.evicted?.role).toBe("text-target");
    expect(text.evictCount()).toBe(1);

    // Nothing left.
    const fourth = await monitor.tick();
    expect(fourth.evicted).toBeNull();
    expect(fourth.exhausted).toBe(true);
  });

  it("re-loaded roles become evictable again on the next pressure tick", async () => {
    const registry = new SharedResourceRegistry();
    const drafter = fakeRole("drafter", 800);
    registry.acquire(drafter.resource);
    const monitor = monitorWithFreeMb(registry, 100);

    const first = await monitor.tick();
    expect(first.evicted?.role).toBe("drafter");
    expect(drafter.evictCount()).toBe(1);

    // Nothing else resident → exhausted now.
    const exhausted = await monitor.tick();
    expect(exhausted.evicted).toBeNull();

    // Caller re-loads the drafter on demand; pressure persists → it can be evicted again.
    drafter.reload();
    const second = await monitor.tick();
    expect(second.evicted?.role).toBe("drafter");
    expect(drafter.evictCount()).toBe(2);
  });

  it("honours the eviction cooldown between ticks", async () => {
    const registry = new SharedResourceRegistry();
    registry.acquire(fakeRole("drafter", 100).resource);
    registry.acquire(fakeRole("tts", 100).resource);
    const monitor = new MemoryMonitor({
      registry,
      config: {
        lowWaterMb: 768,
        lowWaterFraction: 0,
        evictionCooldownMs: 10_000,
      },
      sources: {
        osMemory: () => ({ freeBytes: 100 * MB, totalBytes: 16 * 1024 * MB }),
        serverRssMb: async () => null,
      },
    });
    const t0 = 1_000_000;
    const a = await monitor.tick(t0);
    expect(a.evicted?.role).toBe("drafter");
    // Within the cooldown — no further eviction even though still under pressure.
    const b = await monitor.tick(t0 + 5_000);
    expect(b.evicted).toBeNull();
    // After the cooldown — the next role goes.
    const c = await monitor.tick(t0 + 11_000);
    expect(c.evicted?.role).toBe("tts");
  });

  it("treats a huge llama-server RSS as pressure even when OS free looks fine", async () => {
    const registry = new SharedResourceRegistry();
    const drafter = fakeRole("drafter", 800);
    registry.acquire(drafter.resource);
    const monitor = new MemoryMonitor({
      registry,
      config: {
        lowWaterMb: 1024,
        lowWaterFraction: 0.05,
        evictionCooldownMs: 0,
      },
      sources: {
        // OS reports 4 GB free (looks fine), but the server is 15 GB on a 16 GB box.
        osMemory: () => ({
          freeBytes: 4 * 1024 * MB,
          totalBytes: 16 * 1024 * MB,
        }),
        serverRssMb: async () => 15 * 1024,
      },
    });
    const sample = await monitor.sample();
    expect(monitor.isUnderPressure(sample)).toBe(true);
    const action = await monitor.tick();
    expect(action.evicted?.role).toBe("drafter");
  });

  it("start()/stop() arm and disarm the polling timer", () => {
    const registry = new SharedResourceRegistry();
    const monitor = monitorWithFreeMb(registry, 8 * 1024);
    expect(monitor.isRunning()).toBe(false);
    monitor.start();
    expect(monitor.isRunning()).toBe(true);
    monitor.start(); // idempotent
    expect(monitor.isRunning()).toBe(true);
    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });
});
