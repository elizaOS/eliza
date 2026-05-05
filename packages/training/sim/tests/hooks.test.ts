import { describe, expect, it } from "bun:test";
import type { DrizzleClient } from "@babylon/db";
import { BabylonEngine } from "../core/engine";
import { defineSystem } from "../core/system";
import type { BabylonSystem, EngineContext } from "../core/types";
import { TickPhase } from "../core/types";

function makeTestEngine() {
  return new BabylonEngine({
    db: {} as DrizzleClient,
    llm: { execute: async () => ({}) as never, getClient: () => ({}) },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as import("@babylon/shared").Logger,
    config: { budgetMs: 60000 },
  });
}

function makeModule(
  overrides: Partial<BabylonSystem> & { id: string; phase: TickPhase },
): BabylonSystem {
  return {
    name: overrides.id,
    onTick: async () => ({}),
    ...overrides,
  };
}

describe("Runtime hooks", () => {
  it("fires engine:boot after boot", async () => {
    const engine = makeTestEngine();
    let bootFired = false;
    let bootCtx: EngineContext | null = null;

    engine.hook("engine:boot", (ctx) => {
      bootFired = true;
      bootCtx = ctx;
    });

    engine.use(makeModule({ id: "a", phase: TickPhase.Bootstrap }));
    await engine.boot();

    expect(bootFired).toBe(true);
    expect(bootCtx).toBeTruthy();
    expect(bootCtx!.config.budgetMs).toBe(60000);
    await engine.shutdown();
  });

  it("fires engine:shutdown before shutdown", async () => {
    const engine = makeTestEngine();
    let shutdownFired = false;

    engine.hook("engine:shutdown", () => {
      shutdownFired = true;
    });

    engine.use(makeModule({ id: "a", phase: TickPhase.Bootstrap }));
    await engine.boot();
    await engine.shutdown();

    expect(shutdownFired).toBe(true);
  });

  it("fires tick:before and tick:after around each tick", async () => {
    const events: string[] = [];
    const engine = makeTestEngine();

    engine.hook("tick:before", () => {
      events.push("before");
    });
    engine.hook("tick:after", (_ctx, metrics) => {
      events.push(`after:${typeof metrics}`);
    });

    engine.use(
      makeModule({
        id: "a",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          events.push("tick");
          return {};
        },
      }),
    );

    await engine.boot();
    await engine.tick();

    expect(events).toEqual(["before", "tick", "after:object"]);
    await engine.shutdown();
  });

  it("fires module:before and module:after for each module", async () => {
    const events: string[] = [];
    const engine = makeTestEngine();

    engine.hook("system:before", (systemId) => {
      events.push(`before:${systemId}`);
    });
    engine.hook("system:after", (systemId, _ctx, result) => {
      events.push(`after:${systemId}:${JSON.stringify(result.metrics)}`);
    });

    engine
      .use(
        makeModule({
          id: "first",
          phase: TickPhase.Bootstrap,
          onTick: async () => ({ metrics: { x: 1 } }),
        }),
      )
      .use(
        makeModule({
          id: "second",
          phase: TickPhase.Questions,
          onTick: async () => ({ metrics: { y: 2 } }),
        }),
      );

    await engine.boot();
    await engine.tick();

    expect(events).toEqual([
      "before:first",
      'after:first:{"x":1}',
      "before:second",
      'after:second:{"y":2}',
    ]);
    await engine.shutdown();
  });

  it("fires module:error when a module throws", async () => {
    const engine = makeTestEngine();
    let errorModuleId = "";
    let errorMessage = "";

    engine.hook("system:error", (systemId, error) => {
      errorModuleId = systemId;
      errorMessage = error.message;
    });

    engine.use(
      makeModule({
        id: "broken",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          throw new Error("module crashed");
        },
      }),
    );

    await engine.boot();
    await engine.tick();

    expect(errorModuleId).toBe("broken");
    expect(errorMessage).toBe("module crashed");
    await engine.shutdown();
  });

  it("hookOnce fires only once", async () => {
    const engine = makeTestEngine();
    let count = 0;

    engine.hookOnce("tick:before", () => {
      count++;
    });

    engine.use(makeModule({ id: "a", phase: TickPhase.Bootstrap }));
    await engine.boot();
    await engine.tick();
    await engine.tick();
    await engine.tick();

    expect(count).toBe(1);
    await engine.shutdown();
  });

  it("modules can register hooks via ctx.hooks", async () => {
    const engine = makeTestEngine();
    const hookEvents: string[] = [];

    engine.use(
      defineSystem({
        id: "hook-registrar",
        name: "Hook Registrar",
        phase: TickPhase.Bootstrap,
        register: async (ctx) => {
          ctx.hooks.hook("tick:before", () => {
            hookEvents.push("from-module");
          });
        },
        onTick: async () => ({}),
      }),
    );

    await engine.boot();
    await engine.tick();
    await engine.tick();

    expect(hookEvents).toEqual(["from-module", "from-module"]);
    await engine.shutdown();
  });

  it("hook unregister function works", async () => {
    const engine = makeTestEngine();
    let count = 0;

    const unregister = engine.hook("tick:before", () => {
      count++;
    });

    engine.use(makeModule({ id: "a", phase: TickPhase.Bootstrap }));
    await engine.boot();
    await engine.tick();
    expect(count).toBe(1);

    unregister();
    await engine.tick();
    expect(count).toBe(1);

    await engine.shutdown();
  });
});
