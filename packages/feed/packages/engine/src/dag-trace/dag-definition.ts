/**
 * Static DAG definition for the game tick.
 * Maps directly to the execution flow in game-tick.ts.
 *
 * The DAG flows: Bootstrap -> Questions -> Events -> Markets -> Rebalancing
 *   -> ContentMaintenance -> Social -> Finalize
 *
 * Within Markets, data fans out to individual NPC agents (dynamically added
 * by the tracer) then converges back at Trade Execution.
 */

import type { DagDefinition } from "./types";

export const GAME_TICK_DAG: DagDefinition = {
  nodes: [
    // Bootstrap (100)
    {
      id: "init",
      name: "Initialize",
      phase: "Bootstrap",
      phaseNumber: 100,
      description: "Token stats, LLM client setup, game state fetch",
    },
    {
      id: "bootstrap",
      name: "Bootstrap Game",
      phase: "Bootstrap",
      phaseNumber: 100,
      description: "Create actors, organizations, pools if needed",
    },
    {
      id: "bootstrap-content",
      name: "Bootstrap Content",
      phase: "Bootstrap",
      phaseNumber: 100,
      description: "Initial relationships, trending tags if fresh setup",
    },
    // Questions (200)
    {
      id: "questions-load",
      name: "Load Questions",
      phase: "Questions",
      phaseNumber: 200,
      description: "Fetch active questions from database",
    },
    {
      id: "questions-init",
      name: "Generate Initial Questions",
      phase: "Questions",
      phaseNumber: 200,
      description: "LLM: Generate prediction questions if first tick",
    },
    {
      id: "question-persistence",
      name: "Question Persistence",
      phase: "Questions",
      phaseNumber: 200,
      description: "Persist newly generated questions for offchain trading",
    },
    {
      id: "question-topup",
      name: "Question Top-up",
      phase: "Questions",
      phaseNumber: 200,
      description: "LLM: Generate more questions if < 10 active",
    },
    // Events (300)
    {
      id: "events",
      name: "Generate Events",
      phase: "Events",
      phaseNumber: 300,
      description: "World events and arc pulse events",
    },
    {
      id: "narrative-arcs",
      name: "Narrative Arcs",
      phase: "Events",
      phaseNumber: 300,
      description: "Process arc phase transitions",
    },
    {
      id: "timeframed-markets",
      name: "Timeframed Markets",
      phase: "Events",
      phaseNumber: 300,
      description: "Process multi-timeframe market arcs",
    },
    // Markets (400) — NPC agent nodes are injected dynamically between market-decisions and trade-execution
    {
      id: "market-baseline",
      name: "Baseline Investments",
      phase: "Markets",
      phaseNumber: 400,
      description: "NPC baseline position allocation",
    },
    {
      id: "market-decisions",
      name: "Market Decisions",
      phase: "Markets",
      phaseNumber: 400,
      description: "LLM: Batch NPC trading decisions (main LLM call)",
    },
    {
      id: "trade-execution",
      name: "Trade Execution",
      phase: "Markets",
      phaseNumber: 400,
      description: "Execute NPC trading decisions",
    },
    {
      id: "price-updates",
      name: "Price Updates",
      phase: "Markets",
      phaseNumber: 400,
      description: "Recalculate market prices from trades",
    },
    {
      id: "market-volatility",
      name: "Market Volatility",
      phase: "Markets",
      phaseNumber: 400,
      description: "Simulate random price walks",
    },
    // Rebalancing (500)
    {
      id: "rebalancing",
      name: "Portfolio Rebalancing",
      phase: "Rebalancing",
      phaseNumber: 500,
      description: "Monitor and rebalance NPC portfolios",
    },
    // Content Maintenance (600)
    {
      id: "game-state-update",
      name: "Update Game State",
      phase: "ContentMaintenance",
      phaseNumber: 600,
      description: "DB: lastTickAt, currentDay",
    },
    {
      id: "widget-caches",
      name: "Widget Caches",
      phase: "ContentMaintenance",
      phaseNumber: 600,
      description: "Top gainers, questions, pools",
    },
    {
      id: "trending-tags",
      name: "Trending Tags",
      phase: "ContentMaintenance",
      phaseNumber: 600,
      description: "Recalculate trending topics",
    },
    {
      id: "reputation-sync",
      name: "Reputation Sync",
      phase: "ContentMaintenance",
      phaseNumber: 600,
      description: "Sync on-chain reputation scores",
    },
    // Social (700)
    {
      id: "relationships",
      name: "Relationship Evolution",
      phase: "Social",
      phaseNumber: 700,
      description: "LLM: Analyze NPC interactions, update relationships",
    },
    {
      id: "group-dynamics",
      name: "Group Dynamics",
      phase: "Social",
      phaseNumber: 700,
      description: "LLM: Group formation, messages, joins/kicks",
    },
    {
      id: "alpha-invites",
      name: "Alpha Invites",
      phase: "Social",
      phaseNumber: 700,
      description: "Invite engaged users to alpha groups",
    },
    // Finalize (800)
    {
      id: "token-stats-finalize",
      name: "Finalize Token Stats",
      phase: "Finalize",
      phaseNumber: 800,
      description: "Aggregate LLM usage and costs",
    },
  ],
  edges: [
    // Bootstrap chain
    { source: "init", target: "bootstrap", label: "config" },
    { source: "bootstrap", target: "bootstrap-content", label: "actors" },

    // Bootstrap -> Questions
    { source: "bootstrap-content", target: "questions-load", label: "ready" },

    // Questions flow
    {
      source: "questions-load",
      target: "questions-init",
      label: "activeQuestions",
    },
    {
      source: "questions-init",
      target: "question-persistence",
      label: "newQuestions",
    },
    {
      source: "questions-load",
      target: "question-topup",
      label: "activeCount",
    },

    // Questions -> Events
    { source: "questions-load", target: "events", label: "activeQuestions[]" },

    // Events flow
    { source: "events", target: "narrative-arcs", label: "worldEvents" },
    {
      source: "narrative-arcs",
      target: "timeframed-markets",
      label: "arcEvents",
    },

    // Events -> Markets
    { source: "events", target: "market-baseline", label: "context" },
    { source: "events", target: "market-decisions", label: "worldContext" },
    {
      source: "questions-load",
      target: "market-decisions",
      label: "activeQuestions[]",
    },

    // Markets chain
    // market-decisions -> [NPC agent nodes] -> trade-execution (agents injected dynamically)
    {
      source: "market-baseline",
      target: "market-decisions",
      label: "baseline",
    },
    {
      source: "market-decisions",
      target: "trade-execution",
      label: "decisions[]",
    },
    {
      source: "trade-execution",
      target: "price-updates",
      label: "executedTrades",
    },

    // Volatility from narrative
    {
      source: "narrative-arcs",
      target: "market-volatility",
      label: "eventsGenerated",
    },
    {
      source: "market-volatility",
      target: "price-updates",
      label: "priceWalks",
    },

    // Price -> Rebalancing
    { source: "price-updates", target: "rebalancing", label: "updatedPrices" },

    // Rebalancing -> Content Maintenance
    { source: "rebalancing", target: "game-state-update", label: "complete" },

    // Content Maintenance chain
    {
      source: "game-state-update",
      target: "widget-caches",
      label: "currentDay",
    },
    {
      source: "widget-caches",
      target: "trending-tags",
      label: "updatedCaches",
    },
    { source: "game-state-update", target: "reputation-sync", label: "state" },

    // Content Maintenance -> Social
    { source: "reputation-sync", target: "relationships", label: "reputation" },
    {
      source: "relationships",
      target: "group-dynamics",
      label: "relationships",
    },
    { source: "group-dynamics", target: "alpha-invites", label: "groups" },

    // Social -> Finalize
    { source: "alpha-invites", target: "token-stats-finalize", label: "done" },
    { source: "trending-tags", target: "token-stats-finalize", label: "done" },
  ],
};

/** Phase color mapping for the visualizer */
export const PHASE_COLORS: Record<string, string> = {
  Bootstrap: "#3b82f6",
  Questions: "#06b6d4",
  Events: "#f97316",
  Markets: "#22c55e",
  Rebalancing: "#eab308",
  ContentMaintenance: "#6b7280",
  Social: "#a855f7",
  Finalize: "#ef4444",
  Agent: "#ec4899",
};
