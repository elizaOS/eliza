/**
 * BabylonEngine — core runtime that registers systems and executes ticks.
 *
 * Extends Hookable for lifecycle events (engine:boot, tick:before, system:error, etc.)
 */

import { logger } from "@babylon/shared";
import { Hookable } from "hookable";
import { _engine, _tick } from "./composables";
import {
  type CreateEngineContextOptions,
  createEngineContext,
  createTickContext,
} from "./context";
import {
  CircularDependencyError,
  FrameworkError,
  SystemNotFoundError,
} from "./errors";
import {
  type BabylonSystem,
  type EngineContext,
  type RuntimeHooks,
  type SystemTickResult,
  type TickContext,
  TickPhase,
} from "./types";

export class BabylonEngine extends Hookable<RuntimeHooks> {
  private readonly systems: BabylonSystem[] = [];
  private sorted: BabylonSystem[] = [];
  private engineCtx: EngineContext | null = null;
  private tickNumber = 0;
  private booted = false;
  private readonly lastIntervalRun = new Map<string, number>();

  constructor(private readonly options: CreateEngineContextOptions = {}) {
    super();
  }

  use(system: BabylonSystem): this {
    if (this.booted) {
      throw new FrameworkError(
        "Cannot add systems after boot(). Register all systems before calling boot().",
      );
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(system.id)) {
      throw new FrameworkError(
        `Invalid system ID "${system.id}". IDs must be alphanumeric with dots, hyphens, or underscores.`,
      );
    }
    this.systems.push(system);
    return this;
  }

  async boot(): Promise<void> {
    this.engineCtx = createEngineContext({ ...this.options, hooks: this });
    this.sorted = this.sortSystems(this.systems);

    // Set engine context so composables (useEngine, useDB, etc.) work during register()
    await _engine.callAsync(this.engineCtx, async () => {
      for (const sys of this.sorted) {
        if (sys.register) {
          try {
            await sys.register(this.engineCtx!);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new FrameworkError(
              `System "${sys.id}" failed during register(): ${error.message}`,
            );
          }
        }
      }
    });

    this.booted = true;

    // Set as singleton so useEngine() works between ticks (e.g. in hook handlers)
    _engine.set(this.engineCtx);

    logger.info(
      `BabylonEngine booted with ${this.sorted.length} system(s)`,
      { systems: this.sorted.map((s) => s.id) },
      "Framework",
    );

    await this.callHook("engine:boot", this.engineCtx);
  }

  async tick(
    dayNumber?: number,
  ): Promise<Record<string, number | string | boolean>> {
    if (!this.booted || !this.engineCtx) {
      throw new FrameworkError("Engine not booted. Call boot() first.");
    }

    this.tickNumber++;
    const tickStart = Date.now();
    const ctx = createTickContext(this.engineCtx, this.tickNumber, dayNumber);

    // Wrap the entire tick in unctx so useTick() works everywhere — including async
    return _tick.callAsync(ctx, async () => {
      await this.callHook("tick:before", ctx);

      for (const sys of this.sorted) {
        await this.executeSystem(sys, ctx);
      }

      ctx.metrics.set("_tickDurationMs", Date.now() - tickStart);
      const snapshot = ctx.metrics.snapshot();

      await this.callHook("tick:after", ctx, snapshot);

      return snapshot;
    });
  }

  async shutdown(): Promise<void> {
    await this.callHook("engine:shutdown");

    // Destroy in reverse registration order
    const reversed = [...this.systems].reverse();
    for (const sys of reversed) {
      if (sys.destroy) {
        try {
          await sys.destroy();
        } catch (err) {
          logger.error(
            `Error destroying system "${sys.id}"`,
            err instanceof Error ? err : new Error(String(err)),
            "Framework",
          );
        }
      }
    }
    this.booted = false;
    this.engineCtx = null;
    this.lastIntervalRun.clear();
    _engine.unset();
    this.removeAllHooks();
  }

  private async executeSystem(
    sys: BabylonSystem,
    ctx: TickContext,
  ): Promise<void> {
    const alwaysRun =
      sys.phase === TickPhase.Finalize || sys.skipDeadlineCheck === true;

    if (!alwaysRun && ctx.isPastDeadline()) {
      ctx.metrics.addWarning(`Skipped system "${sys.id}" — past deadline`);
      return;
    }

    const start = Date.now();
    try {
      await this.callHook("system:before", sys.id, ctx);

      const result = await sys.onTick(ctx);
      this.mergeResult(ctx, result);

      await this.callHook("system:after", sys.id, ctx, result);

      if (sys.intervals) {
        for (const [name, interval] of Object.entries(sys.intervals)) {
          const shouldRun = this.shouldRunInterval(sys.id, name, interval, ctx);
          if (shouldRun) {
            try {
              const intervalResult = await interval.handler(ctx);
              this.mergeResult(ctx, intervalResult);
            } catch (err) {
              ctx.metrics.addWarning(
                `Interval "${name}" of system "${sys.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`System "${sys.id}" failed during tick`, error, "Framework");
      ctx.metrics.addWarning(`System "${sys.id}" failed: ${error.message}`);

      await this.callHook("system:error", sys.id, error, ctx);
    } finally {
      ctx.metrics.set(`_system.${sys.id}.durationMs`, Date.now() - start);
    }
  }

  private shouldRunInterval(
    systemId: string,
    intervalName: string,
    interval: { every?: number; everyMs?: number },
    ctx: TickContext,
  ): boolean {
    if (interval.every === undefined && interval.everyMs === undefined) {
      ctx.metrics.addWarning(
        `Interval "${intervalName}" of system "${systemId}" has neither every nor everyMs, skipping`,
      );
      return false;
    }
    if (interval.every !== undefined) {
      if (interval.every < 1) {
        ctx.metrics.addWarning(
          `Interval "${intervalName}" of system "${systemId}" has invalid every=${interval.every}, skipping`,
        );
        return false;
      }
      if (ctx.tickNumber % interval.every === 0) {
        return true;
      }
    }
    if (interval.everyMs !== undefined) {
      if (interval.everyMs < 1) {
        ctx.metrics.addWarning(
          `Interval "${intervalName}" of system "${systemId}" has invalid everyMs=${interval.everyMs}, skipping`,
        );
        return false;
      }
      const key = `${systemId}:${intervalName}`;
      const lastRun = this.lastIntervalRun.get(key) ?? 0;
      const now = ctx.timestamp.getTime();
      if (now - lastRun >= interval.everyMs) {
        this.lastIntervalRun.set(key, now);
        return true;
      }
    }
    return false;
  }

  private mergeResult(ctx: TickContext, result: SystemTickResult): void {
    if (result.metrics) {
      for (const [key, value] of Object.entries(result.metrics)) {
        if (typeof value === "number") {
          ctx.metrics.increment(key, value);
        } else {
          ctx.metrics.set(key, value);
        }
      }
    }
    if (result.sharedData) {
      for (const [key, value] of Object.entries(result.sharedData)) {
        ctx.shared.set(key, value);
      }
    }
    if (result.warnings) {
      for (const w of result.warnings) {
        ctx.metrics.addWarning(w);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Topological sort within phases
  // ---------------------------------------------------------------------------

  private sortSystems(systems: BabylonSystem[]): BabylonSystem[] {
    const byPhase = new Map<TickPhase, BabylonSystem[]>();
    for (const sys of systems) {
      const group = byPhase.get(sys.phase) ?? [];
      group.push(sys);
      byPhase.set(sys.phase, group);
    }

    const phases = [...byPhase.keys()].sort((a, b) => a - b);
    const result: BabylonSystem[] = [];
    const allIds = new Set(systems.map((s) => s.id));

    for (const phase of phases) {
      const group = byPhase.get(phase)!;
      const sorted = this.topoSort(group, allIds);
      result.push(...sorted);
    }

    return result;
  }

  private topoSort(
    systems: BabylonSystem[],
    allIds: Set<string>,
  ): BabylonSystem[] {
    const idToSys = new Map(systems.map((s) => [s.id, s]));
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const sys of systems) {
      inDegree.set(sys.id, 0);
      adj.set(sys.id, []);
    }

    for (const sys of systems) {
      if (!sys.dependencies) continue;
      for (const dep of sys.dependencies) {
        if (!allIds.has(dep)) {
          throw new SystemNotFoundError(dep, sys.id);
        }
        if (idToSys.has(dep)) {
          adj.get(dep)!.push(sys.id);
          inDegree.set(sys.id, inDegree.get(sys.id)! + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: BabylonSystem[] = [];
    const sortedIds = new Set<string>();
    let qi = 0;
    while (qi < queue.length) {
      const id = queue[qi++]!;
      sorted.push(idToSys.get(id)!);
      sortedIds.add(id);
      for (const neighbor of adj.get(id)!) {
        const newDeg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== systems.length) {
      const remaining = systems
        .filter((s) => !sortedIds.has(s.id))
        .map((s) => s.id);
      throw new CircularDependencyError(remaining);
    }

    return sorted;
  }
}
