/**
 * Integration coverage for VisionService wiring into describe-loop backpressure.
 *
 * The pure controller is unit-tested separately; this file exercises runtime
 * arbiter subscription, pressure propagation, manual resume, stats, and stop cleanup.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { IModelArbiter } from "./lifecycle";
import { VisionService } from "./service";

type PressureCb = (holders: string[]) => void;

function makeRuntime(arbiter: IModelArbiter | null) {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: vi.fn((name: string) =>
      name === "MEMORY_ARBITER" ? arbiter : null,
    ),
    getServicesByType: vi.fn(() => []),
  });
}

function makeArbiter() {
  let pressureCb: PressureCb | null = null;
  const unsubscribe = vi.fn();
  const arbiter: IModelArbiter = {
    acquire: vi.fn(() => true),
    release: vi.fn(),
    onPressure: vi.fn((cb: PressureCb) => {
      pressureCb = cb;
      return unsubscribe;
    }),
  };
  return {
    arbiter,
    unsubscribe,
    fire: (holders: string[] = []) => pressureCb?.(holders),
  };
}

const attach = (svc: VisionService) =>
  (svc as unknown as { attachMemoryArbiter(): void }).attachMemoryArbiter();

describe("VisionService ↔ DescribeBackpressureController wiring (#9688)", () => {
  it("cascades arbiter pressure into the controller and resumes explicitly", () => {
    const { arbiter, fire } = makeArbiter();
    const svc = new VisionService(makeRuntime(arbiter));

    attach(svc);
    expect(arbiter.onPressure).toHaveBeenCalledTimes(1);
    expect(svc.getBackpressureStats().pressureLevel).toBe("nominal");

    // A pressure event flips the controller to critical (paused only flips
    // inside evaluate(), which getBackpressureStats does not call — assert the
    // pressure level, not `paused`).
    fire();
    expect(svc.getBackpressureStats().pressureLevel).toBe("critical");

    svc.resumeDescribeLoop();
    expect(svc.getBackpressureStats().pressureLevel).toBe("nominal");
  });

  it("does not double-subscribe on re-attach: the prior subscription is released first", () => {
    const { arbiter, unsubscribe } = makeArbiter();
    const svc = new VisionService(makeRuntime(arbiter));

    attach(svc);
    attach(svc);
    expect(arbiter.onPressure).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("releases the arbiter subscription on stop()", async () => {
    const { arbiter, unsubscribe } = makeArbiter();
    const svc = new VisionService(makeRuntime(arbiter));

    attach(svc);
    await svc.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no arbiter is registered (standalone path stays usable)", () => {
    const svc = new VisionService(makeRuntime(null));
    expect(() => attach(svc)).not.toThrow();
    expect(svc.getBackpressureStats().pressureLevel).toBe("nominal");
    svc.resumeDescribeLoop();
    expect(svc.getBackpressureStats().paused).toBe(false);
  });
});
