/**
 * Benchmark Data Viewer
 *
 * Provides utilities to view and inspect benchmark data.
 * Useful for validation and understanding benchmark structure.
 */

import { promises as fs } from "node:fs";
import type { JsonValue } from "../adapter";
import type {
  BenchmarkGameSnapshot,
  GameState,
  GroundTruth,
  Tick,
} from "./BenchmarkDataGenerator";
import * as BenchmarkValidator from "./BenchmarkValidator";

export interface BenchmarkViewOptions {
  /** Show detailed information */
  verbose?: boolean;

  /** Show only summary */
  summary?: boolean;

  /** Show ground truth data */
  showGroundTruth?: boolean;

  /** Show hidden facts/events */
  showHidden?: boolean;

  /** Filter by tick range */
  tickRange?: { start: number; end: number };
}

export interface BenchmarkView {
  /** Basic info */
  id: string;
  version: string;
  createdAt: number;
  duration: number;
  tickInterval: number;

  /** State summary */
  initialState: {
    predictionMarkets: number;
    perpetualMarkets: number;
    agents: number;
    posts: number;
    groupChats: number;
  };

  /** Ticks summary */
  ticks: {
    total: number;
    withEvents: number;
    eventTypes: Record<string, number>;
  };

  /** Ground truth summary */
  groundTruth?: {
    marketOutcomes: number;
    priceHistory: Record<string, number>;
    optimalActions: number;
    socialOpportunities: number;
    hiddenFacts: number;
    hiddenEvents: number;
    trueFacts: string[];
  };

  /** Validation results */
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
}

function analyzeTicks(ticks: Tick[]): BenchmarkView["ticks"] {
  const eventTypes: Record<string, number> = {};
  let withEvents = 0;

  for (const tick of ticks) {
    if (tick.events.length > 0) {
      withEvents++;
    }

    for (const event of tick.events) {
      eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
    }
  }

  return {
    total: ticks.length,
    withEvents,
    eventTypes,
  };
}

function analyzeGroundTruth(
  groundTruth: GroundTruth,
): BenchmarkView["groundTruth"] {
  return {
    marketOutcomes: Object.keys(groundTruth.marketOutcomes).length,
    priceHistory: Object.fromEntries(
      Object.entries(groundTruth.priceHistory).map(([ticker, history]) => [
        ticker,
        history.length,
      ]),
    ),
    optimalActions: groundTruth.optimalActions.length,
    socialOpportunities: groundTruth.socialOpportunities.length,
    hiddenFacts: groundTruth.hiddenFacts?.length || 0,
    hiddenEvents: groundTruth.hiddenEvents?.length || 0,
    trueFacts: Object.keys(groundTruth.trueFacts || {}),
  };
}

/**
 * Load and view a benchmark file
 */
export async function viewBenchmark(
    filePath: string,
    options: BenchmarkViewOptions = {},
  ): Promise<BenchmarkView> {
    const data = await fs.readFile(filePath, "utf-8");
    const snapshot = JSON.parse(data) as BenchmarkGameSnapshot;

    // Validate
    const validation = BenchmarkValidator.validate(snapshot);

    // Build view
    const view: BenchmarkView = {
      id: snapshot.id,
      version: snapshot.version,
      createdAt: snapshot.createdAt,
      duration: snapshot.duration,
      tickInterval: snapshot.tickInterval,

      initialState: {
        predictionMarkets: snapshot.initialState.predictionMarkets.length,
        perpetualMarkets: snapshot.initialState.perpetualMarkets.length,
        agents: snapshot.initialState.agents.length,
        posts: snapshot.initialState.posts?.length || 0,
        groupChats: snapshot.initialState.groupChats?.length || 0,
      },

      ticks: analyzeTicks(snapshot.ticks),

      validation,
    };

    if (options.showGroundTruth || options.verbose) {
      view.groundTruth = analyzeGroundTruth(snapshot.groundTruth);
    }

    return view;
  }

/**
 * Print view to console
 */
export function printBenchmarkView(view: BenchmarkView, options: BenchmarkViewOptions = {}): void {
    console.log("\n📊 Benchmark Data View\n");
    console.log(`ID: ${view.id}`);
    console.log(`Version: ${view.version}`);
    console.log(`Created: ${new Date(view.createdAt).toISOString()}`);
    console.log(`Duration: ${(view.duration / 60).toFixed(1)} minutes`);
    console.log(`Tick Interval: ${view.tickInterval}s`);

    console.log("\n📈 Initial State:");
    console.log(`  Prediction Markets: ${view.initialState.predictionMarkets}`);
    console.log(`  Perpetual Markets: ${view.initialState.perpetualMarkets}`);
    console.log(`  Agents: ${view.initialState.agents}`);
    console.log(`  Posts: ${view.initialState.posts}`);
    console.log(`  Group Chats: ${view.initialState.groupChats}`);

    console.log("\n⏱️  Ticks:");
    console.log(`  Total: ${view.ticks.total}`);
    console.log(`  With Events: ${view.ticks.withEvents}`);
    if (options.verbose) {
      console.log(`  Event Types:`);
      for (const [type, count] of Object.entries(view.ticks.eventTypes)) {
        console.log(`    ${type}: ${count}`);
      }
    }

    if (view.groundTruth) {
      console.log("\n🎯 Ground Truth:");
      console.log(`  Market Outcomes: ${view.groundTruth.marketOutcomes}`);
      console.log(`  Price History:`);
      for (const [ticker, count] of Object.entries(
        view.groundTruth.priceHistory,
      )) {
        console.log(`    ${ticker}: ${count} ticks`);
      }
      console.log(`  Optimal Actions: ${view.groundTruth.optimalActions}`);
      console.log(
        `  Social Opportunities: ${view.groundTruth.socialOpportunities}`,
      );
      if (options.showHidden) {
        console.log(`  Hidden Facts: ${view.groundTruth.hiddenFacts}`);
        console.log(`  Hidden Events: ${view.groundTruth.hiddenEvents}`);
        console.log(`  True Facts: ${view.groundTruth.trueFacts.join(", ")}`);
      }
    }

    console.log("\n✅ Validation:");
    console.log(`  Valid: ${view.validation.valid ? "✅" : "❌"}`);
    if (view.validation.errors.length > 0) {
      console.log(`  Errors: ${view.validation.errors.length}`);
      if (options.verbose) {
        for (const error of view.validation.errors) {
          console.log(`    ❌ ${error}`);
        }
      }
    }
    if (view.validation.warnings.length > 0) {
      console.log(`  Warnings: ${view.validation.warnings.length}`);
      if (options.verbose) {
        for (const warning of view.validation.warnings) {
          console.log(`    ⚠️  ${warning}`);
        }
      }
    }

    console.log("");
}

/**
 * Get tick details
 */
export function getTickDetails(
    snapshot: BenchmarkGameSnapshot,
    tickNumber: number,
  ): {
    tick: Tick | null;
    state: GameState | null;
    events: Array<{ type: string; data: Record<string, JsonValue> }>;
  } {
    const tick = snapshot.ticks[tickNumber] || null;

    if (!tick) {
      return { tick: null, state: null, events: [] };
    }

    return {
      tick,
      state: tick.state,
      events: tick.events.map((e) => ({
        type: e.type,
        data: e.data,
      })),
    };
}

/**
 * Get ground truth for a specific tick
 */
export function getGroundTruthForTick(
    snapshot: BenchmarkGameSnapshot,
    tickNumber: number,
  ): {
    hiddenFacts: Array<{ fact: string; category: string }>;
    hiddenEvents: Array<{ type: string; description: string }>;
    marketOutcomes: Record<string, boolean>;
  } {
    const gt = snapshot.groundTruth;

    return {
      hiddenFacts: (gt.hiddenFacts || [])
        .filter((f) => f.tick === tickNumber)
        .map((f) => ({ fact: f.fact, category: f.category })),
      hiddenEvents: (gt.hiddenEvents || [])
        .filter((e) => e.tick === tickNumber)
        .map((e) => ({ type: e.type, description: e.description })),
      marketOutcomes: gt.marketOutcomes,
    };
}

/**
 * Check if agent can access hidden facts (should always be false)
 */
export function verifyAgentCannotAccessHiddenFacts(snapshot: BenchmarkGameSnapshot): {
    canAccess: boolean;
    reason: string;
  } {
    // Agents can only access game state via SimulationA2AInterface
    // Ground truth is stored separately and not exposed
    // This is a verification check

    const state = snapshot.initialState;
    const hasGroundTruth = !!snapshot.groundTruth;
    const hasHiddenFacts = !!snapshot.groundTruth?.hiddenFacts?.length;

    // Check if ground truth is accidentally in state
    const stateKeys = Object.keys(state);
    const hasGroundTruthInState =
      stateKeys.includes("groundTruth") ||
      stateKeys.includes("hiddenFacts") ||
      stateKeys.includes("hiddenEvents");

    if (hasGroundTruthInState) {
      return {
        canAccess: true,
        reason: "Ground truth found in game state (security issue!)",
      };
    }

    return {
      canAccess: false,
      reason:
        hasGroundTruth && hasHiddenFacts
          ? "Ground truth exists but is properly isolated from game state"
          : "No ground truth data found",
    };
}

/** @deprecated Use viewBenchmark, printBenchmarkView, etc. instead */
export const BenchmarkDataViewer = {
  view: viewBenchmark,
  print: printBenchmarkView,
  getTickDetails,
  getGroundTruthForTick,
  verifyAgentCannotAccessHiddenFacts,
};
