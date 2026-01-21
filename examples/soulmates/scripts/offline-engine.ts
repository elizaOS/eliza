#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runEngineTick } from "../engine/engine";
import {
  DEFAULT_NOW,
  DEFAULT_SEED,
  generateEngineState,
} from "../engine/generator";
import { HeuristicLlmProvider } from "../engine/llm";
import { createDefaultLocationProvider } from "../engine/locations";
import type {
  DomainMode,
  EngineOptions,
  EngineRunResult,
  EngineState,
  LlmProvider,
  MatchStatus,
} from "../engine/types";

type OfflineEngineConfig = {
  seed: number;
  personaCount: number;
  feedbackEvents: number;
  ticks: number;
  batchSize: number;
  maxCandidates: number;
  smallPassTopK: number;
  largePassTopK: number;
  graphHops: number;
  matchCooldownDays: number;
  reliabilityWeight: number;
  minAvailabilityMinutes: number;
  matchDomains: DomainMode[];
  autoScheduleMatches: boolean;
  requireSameCity: boolean;
  requireSharedInterests: boolean;
  llmMode: "heuristic" | "none";
  outputDir: string;
  now: string;
  tickHours: number;
};

type TickSummary = {
  tick: number;
  now: string;
  matchesCreated: number;
  feedbackProcessed: number;
  personasUpdated: number;
};

type RunSummary = {
  config: OfflineEngineConfig;
  ticks: TickSummary[];
  totals: {
    matchesCreated: number;
    feedbackProcessed: number;
    personasUpdated: number;
  };
  finalCounts: {
    personas: number;
    matches: number;
    meetings: number;
    feedbackQueue: number;
    feedbackUnprocessed: number;
  };
  matchStatusCounts: Record<MatchStatus, number>;
};

const DOMAIN_LOOKUP: Record<DomainMode, true> = {
  general: true,
  business: true,
  dating: true,
  friendship: true,
};

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const valueIndex = arg.indexOf("=");
    if (valueIndex === -1) {
      parsed[arg.slice(2)] = "true";
      continue;
    }
    const key = arg.slice(2, valueIndex);
    const value = arg.slice(valueIndex + 1);
    if (key) {
      parsed[key] = value;
    }
  }
  return parsed;
};

const readNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  return value === "true" || value === "1";
};

const parseDomains = (value: string | undefined): DomainMode[] => {
  if (!value) return [];
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.filter((token): token is DomainMode =>
    Object.hasOwn(DOMAIN_LOOKUP, token),
  );
};

const buildConfig = (): OfflineEngineConfig => {
  const args = parseArgs();
  const personaCount = Math.max(1, Math.floor(readNumber(args.personas, 200)));
  const argDomains = parseDomains(args.domains);
  const envDomains = parseDomains(process.env.SOULMATES_MATCH_DOMAINS);
  const defaultDomains = parseDomains(process.env.SOULMATES_DEFAULT_DOMAINS);
  const matchDomains =
    argDomains.length > 0
      ? argDomains
      : envDomains.length > 0
        ? envDomains
        : defaultDomains.length > 0
          ? defaultDomains
          : (["dating", "friendship", "business", "general"] as DomainMode[]);

  return {
    seed: Math.floor(readNumber(args.seed, DEFAULT_SEED)),
    personaCount,
    feedbackEvents: Math.max(0, Math.floor(readNumber(args.feedback, 240))),
    ticks: Math.max(1, Math.floor(readNumber(args.ticks, 6))),
    batchSize: Math.max(1, Math.floor(readNumber(args.batch, personaCount))),
    maxCandidates: Math.max(1, Math.floor(readNumber(args.maxCandidates, 60))),
    smallPassTopK: Math.max(1, Math.floor(readNumber(args.smallTopK, 12))),
    largePassTopK: Math.max(1, Math.floor(readNumber(args.largeTopK, 6))),
    graphHops: Math.max(1, Math.floor(readNumber(args.graphHops, 2))),
    matchCooldownDays: Math.max(
      1,
      Math.floor(readNumber(args.cooldownDays, 30)),
    ),
    reliabilityWeight: Math.max(0, readNumber(args.reliabilityWeight, 1)),
    minAvailabilityMinutes: Math.max(
      30,
      Math.floor(readNumber(args.minAvailabilityMinutes, 120)),
    ),
    matchDomains,
    autoScheduleMatches: readBoolean(args.autoSchedule, true),
    requireSameCity: readBoolean(args.requireSameCity, true),
    requireSharedInterests: readBoolean(args.requireSharedInterests, true),
    llmMode: args.llm === "none" ? "none" : "heuristic",
    outputDir: args.output ?? "data/offline-engine",
    now: args.now ?? DEFAULT_NOW,
    tickHours: Math.max(1, Math.floor(readNumber(args.tickHours, 6))),
  };
};

const buildEngineOptions = (
  config: OfflineEngineConfig,
  now: string,
  targetPersonaIds: number[],
): EngineOptions => ({
  now,
  batchSize: config.batchSize,
  maxCandidates: config.maxCandidates,
  smallPassTopK: config.smallPassTopK,
  largePassTopK: config.largePassTopK,
  graphHops: config.graphHops,
  matchCooldownDays: config.matchCooldownDays,
  reliabilityWeight: config.reliabilityWeight,
  minAvailabilityMinutes: config.minAvailabilityMinutes,
  matchDomains: config.matchDomains,
  targetPersonaIds,
  autoScheduleMatches: config.autoScheduleMatches,
  requireSameCity: config.requireSameCity,
  requireSharedInterests: config.requireSharedInterests,
});

async function main(): Promise<void> {
  const config = buildConfig();
  const outputDir = resolve(process.cwd(), config.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const llm: LlmProvider | undefined =
    config.llmMode === "heuristic" ? new HeuristicLlmProvider() : undefined;
  const locationProvider = config.autoScheduleMatches
    ? createDefaultLocationProvider()
    : undefined;

  let state: EngineState = generateEngineState({
    seed: config.seed,
    personaCount: config.personaCount,
    feedbackEvents: config.feedbackEvents,
    now: config.now,
  });

  const summaries: TickSummary[] = [];
  let totalMatches = 0;
  let totalFeedback = 0;
  let totalUpdates = 0;

  const baseTime = Number.isFinite(Date.parse(config.now))
    ? Date.parse(config.now)
    : Date.now();
  const targetPersonaIds = state.personas.map((persona) => persona.id);

  for (let index = 0; index < config.ticks; index += 1) {
    const tickNow = new Date(
      baseTime + index * config.tickHours * 60 * 60 * 1000,
    ).toISOString();
    const options = buildEngineOptions(config, tickNow, targetPersonaIds);
    const result: EngineRunResult = await runEngineTick(state, options, {
      llm,
      locationProvider,
    });

    state = result.state;
    const tickSummary: TickSummary = {
      tick: index + 1,
      now: tickNow,
      matchesCreated: result.matchesCreated.length,
      feedbackProcessed: result.feedbackProcessed.length,
      personasUpdated: result.personasUpdated.length,
    };
    summaries.push(tickSummary);
    totalMatches += tickSummary.matchesCreated;
    totalFeedback += tickSummary.feedbackProcessed;
    totalUpdates += tickSummary.personasUpdated;
  }

  const matchStatusCounts: Record<MatchStatus, number> = {
    proposed: 0,
    accepted: 0,
    scheduled: 0,
    completed: 0,
    canceled: 0,
    expired: 0,
  };
  for (const match of state.matches) {
    matchStatusCounts[match.status] += 1;
  }
  const feedbackUnprocessed = state.feedbackQueue.filter(
    (entry) => !entry.processed,
  ).length;

  const summary: RunSummary = {
    config,
    ticks: summaries,
    totals: {
      matchesCreated: totalMatches,
      feedbackProcessed: totalFeedback,
      personasUpdated: totalUpdates,
    },
    finalCounts: {
      personas: state.personas.length,
      matches: state.matches.length,
      meetings: state.meetings.length,
      feedbackQueue: state.feedbackQueue.length,
      feedbackUnprocessed,
    },
    matchStatusCounts,
  };

  writeFileSync(
    resolve(outputDir, "engine-state.json"),
    JSON.stringify(state, null, 2),
  );
  writeFileSync(
    resolve(outputDir, "run-summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log(`Offline engine run complete. Output written to ${outputDir}`);
}

main().catch((error: Error) => {
  console.error("Offline engine run failed:", error.message);
  process.exit(1);
});
