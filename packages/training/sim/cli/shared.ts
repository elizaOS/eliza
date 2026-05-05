/**
 * Shared utilities for CLI commands.
 */

import consola from "consola";
import type { BabylonRuntimeConfig } from "../core/config";
import { BabylonEngine } from "../core/engine";
import { scanSystems } from "../core/scanner";
import { type BabylonSystem, TickPhase } from "../core/types";

export const phaseNames: Record<number, string> = {
  [TickPhase.Bootstrap]: "Bootstrap",
  [TickPhase.Questions]: "Questions",
  [TickPhase.Events]: "Events",
  [TickPhase.Markets]: "Markets",
  [TickPhase.Rebalancing]: "Rebalancing",
  [TickPhase.ContentMaintenance]: "Content Maintenance",
  [TickPhase.Social]: "Social",
  [TickPhase.Finalize]: "Finalize",
};

export function phaseName(phase: number): string {
  return phaseNames[phase] ?? `Phase(${phase})`;
}

export async function buildEngine(
  config: BabylonRuntimeConfig,
  rootDir: string,
  includeLegacy: boolean,
): Promise<BabylonEngine> {
  const {
    systemsDir: _systemsDir,
    disabledSystems: _disabledSystems,
    systemPhases: _systemPhases,
    migratedSubsystems: _migratedSubsystems,
    dev: _dev,
    ...customKeys
  } = config;
  const engine = new BabylonEngine({
    config: { budgetMs: config.budgetMs ?? 60_000, ...customKeys },
  });

  if (includeLegacy) {
    const { createLegacyGameTickSystem } = await import(
      "../core/bridge/legacy-game-tick"
    );
    engine.use(
      createLegacyGameTickSystem({
        skip: config.migratedSubsystems,
      }),
    );
  }

  const { systems } = await scanSystems(
    config.systemsDir ?? "./systems",
    rootDir,
  );

  const phaseOverrides = config.systemPhases ?? {};
  const validPhases = new Set(Object.values(TickPhase));

  function applyPhaseOverride(sys: BabylonSystem): BabylonSystem {
    const override = phaseOverrides[sys.id];
    if (override === undefined) return sys;
    if (typeof override !== "number" || !validPhases.has(override)) {
      consola.warn(
        `Ignoring invalid phase override for "${sys.id}": ${String(override)}`,
      );
      return sys;
    }
    if (sys.phase === override) return sys;
    try {
      (sys as { phase: TickPhase }).phase = override;
      return sys;
    } catch {
      return {
        id: sys.id,
        name: sys.name,
        phase: override,
        dependencies: sys.dependencies,
        skipDeadlineCheck: sys.skipDeadlineCheck,
        intervals: sys.intervals,
        register: sys.register ? (ctx) => sys.register!(ctx) : undefined,
        onTick: (ctx) => sys.onTick(ctx),
        destroy: sys.destroy ? () => sys.destroy!() : undefined,
      };
    }
  }

  let scanned = 0;
  for (const sys of systems) {
    if (config.disabledSystems?.includes(sys.id)) {
      consola.warn(`System "${sys.id}" disabled by config`);
      continue;
    }
    engine.use(applyPhaseOverride(sys));
    scanned++;
  }

  consola.info(
    includeLegacy
      ? `Registered ${scanned} scanned system(s) + legacy bridge`
      : `Registered ${scanned} system(s)`,
  );
  await engine.boot();
  return engine;
}

export function parseInterval(value: string, label: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    consola.warn(`Invalid ${label}: "${value}", defaulting to 60`);
    return 60;
  }
  return parsed;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([[\]|])/g, "\\$1");
}
