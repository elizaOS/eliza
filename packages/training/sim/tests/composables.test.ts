import { describe, expect, it } from "bun:test";
import type { DrizzleClient } from "@babylon/db";
import {
  tryUseTick,
  useDB,
  useEngine,
  useHooks,
  useLLM,
  useMetrics,
  useServices,
  useShared,
  useTick,
} from "../core/composables";
import { BabylonEngine } from "../core/engine";
import { defineSystem } from "../core/system";
import type { EngineContext, TickContext } from "../core/types";
import { TickPhase } from "../core/types";

function makeTestEngine() {
  return new BabylonEngine({
    db: { _marker: "test-db" } as unknown as DrizzleClient,
    llm: {
      execute: async () => ({ result: true }) as never,
      getClient: () => ({ _marker: "test-client" }),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as import("@babylon/shared").Logger,
    config: { budgetMs: 60000 },
  });
}

describe("composables inside onTick", () => {
  it("useDB returns the db instance", async () => {
    let dbRef: unknown;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "db-test",
        name: "DB Test",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          dbRef = useDB();
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    expect((dbRef as { _marker: string })._marker).toBe("test-db");
    await engine.shutdown();
  });

  it("useLLM returns the llm orchestrator", async () => {
    let llmRef: unknown;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "llm-test",
        name: "LLM Test",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          llmRef = useLLM();
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    expect(typeof (llmRef as { execute: unknown }).execute).toBe("function");
    await engine.shutdown();
  });

  it("useHooks returns the runtime hookable", async () => {
    let hooksRef: unknown;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "hooks-test",
        name: "Hooks Test",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          hooksRef = useHooks();
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    expect(typeof (hooksRef as { hook: unknown }).hook).toBe("function");
    await engine.shutdown();
  });

  it("useServices returns the service container", async () => {
    let servicesRef: unknown;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "svc-test",
        name: "Services Test",
        phase: TickPhase.Bootstrap,
        register: async (ctx: EngineContext) => {
          ctx.services.register("cache", { type: "memory" });
        },
        onTick: async () => {
          servicesRef = useServices();
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    expect((servicesRef as { has: (t: string) => boolean }).has("cache")).toBe(
      true,
    );
    await engine.shutdown();
  });

  it("useMetrics returns the tick metrics", async () => {
    let metricsWorked = false;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "metrics-test",
        name: "Metrics Test",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          const m = useMetrics();
          m.set("fromComposable", true);
          metricsWorked = true;
          return {};
        },
      }),
    );
    await engine.boot();
    const result = await engine.tick();
    expect(metricsWorked).toBe(true);
    expect(result.fromComposable).toBe(true);
    await engine.shutdown();
  });

  it("useShared returns the tick shared data", async () => {
    let sharedWorked = false;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "producer",
        name: "Producer",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          useShared().set("direct", "composed");
          return {};
        },
      }),
    );
    engine.use(
      defineSystem({
        id: "consumer",
        name: "Consumer",
        phase: TickPhase.Questions,
        onTick: async () => {
          sharedWorked = useShared().get<string>("direct") === "composed";
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    expect(sharedWorked).toBe(true);
    await engine.shutdown();
  });

  it("tryUseTick returns context inside a tick", async () => {
    let tickCtx: TickContext | null = null;
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "try-tick",
        name: "Try Tick",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          tickCtx = tryUseTick();
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    expect(tickCtx).toBeTruthy();
    expect(tickCtx!.tickNumber).toBe(1);
    await engine.shutdown();
  });

  it("useTick provides correct tick number across multiple ticks", async () => {
    const tickNumbers: number[] = [];
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "tick-counter",
        name: "Tick Counter",
        phase: TickPhase.Bootstrap,
        onTick: async () => {
          tickNumbers.push(useTick().tickNumber);
          return {};
        },
      }),
    );
    await engine.boot();
    await engine.tick();
    await engine.tick();
    await engine.tick();
    expect(tickNumbers).toEqual([1, 2, 3]);
    await engine.shutdown();
  });
});

describe("composables outside tick", () => {
  it("tryUseTick returns falsy outside a tick", () => {
    expect(tryUseTick()).toBeFalsy();
  });

  it("useEngine works as singleton after boot", async () => {
    const engine = makeTestEngine();
    engine.use(
      defineSystem({
        id: "noop",
        name: "Noop",
        phase: TickPhase.Bootstrap,
        onTick: async () => ({}),
      }),
    );
    await engine.boot();
    const ctx = useEngine();
    expect(ctx.config.budgetMs).toBe(60000);
    await engine.shutdown();
  });
});
