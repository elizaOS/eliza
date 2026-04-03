/**
 * Moltbook Plugin Definition
 *
 * Main plugin export that registers the Moltbook service,
 * actions, providers, and tasks with elizaOS.
 *
 * ## WHY THIS STRUCTURE?
 *
 * elizaOS plugins are declarative - you describe WHAT the plugin provides,
 * and the runtime handles registration and lifecycle. This approach:
 *
 * - **Simplifies integration**: Just export a Plugin object
 * - **Enables introspection**: Runtime can list capabilities
 * - **Supports hot-reload**: Declarative = easier to reload
 *
 * ## PLUGIN COMPONENTS
 *
 * - **init()**: Runs once at startup, validates config, shows banner
 * - **services[]**: Long-running stateful components (our MoltbookService)
 * - **actions[]**: Things the agent can DO (post, comment, vote, etc.)
 * - **providers[]**: Context injected into prompts (status, community analysis)
 *
 * ## WHY ZOD FOR CONFIG?
 *
 * Zod provides runtime validation with great error messages.
 * Catches config errors early, before they cause cryptic failures.
 */

import type { Plugin } from "@elizaos/core";
import { z } from "zod";
import {
  browseAction,
  commentAction,
  followAction,
  moltbookReadAction,
  moltbookSubmoltsAction,
  postAction,
  searchAction,
  voteAction,
} from "./actions/index";
import { type PluginSetting, printBanner } from "./banner";
import { PLUGIN_DESCRIPTION, PLUGIN_NAME } from "./constants";
import { reflectionEvaluator } from "./evaluators/index";
import {
  moltbookContextProvider,
  moltbookFullAnalysisProvider,
  moltbookStatusProvider,
} from "./providers/index";
import { MoltbookService } from "./service";

/**
 * Configuration schema for the plugin
 *
 * WHY ALL STRINGS? Environment variables are always strings.
 * We parse "true"/"false" at runtime rather than requiring boolean coercion.
 */
const configSchema = z.object({
  /** Pre-existing API key - skip auto-registration if provided */
  MOLTBOOK_API_KEY: z.string().optional().describe("Optional: Pre-existing Moltbook API key"),

  /** Enable zero-config startup by auto-registering new accounts */
  MOLTBOOK_AUTO_REGISTER: z
    .string()
    .optional()
    .default("true")
    .describe("Auto-register a new account if no credentials exist"),

  /** Let agents post without human prompting */
  MOLTBOOK_AUTO_ENGAGE: z
    .string()
    .optional()
    .default("true")
    .describe("Enable autonomous posting and engagement"),

  /** Quality bar for autonomous posts (1-10 scale) */
  MOLTBOOK_MIN_QUALITY_SCORE: z
    .string()
    .optional()
    .default("7")
    .describe("Minimum quality score (1-10) for autonomous posts"),
});

export const moltbookPlugin: Plugin = {
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,

  /**
   * Default configuration values.
   *
   * WHY DEFAULTS HERE? These are fallbacks if not specified in .env or character.
   * The ?? operator ensures we only use default if value is null/undefined.
   */
  config: {
    MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY ?? null,
    MOLTBOOK_AUTO_REGISTER: process.env.MOLTBOOK_AUTO_REGISTER ?? "true",
    MOLTBOOK_AUTO_ENGAGE: process.env.MOLTBOOK_AUTO_ENGAGE ?? "true",
    MOLTBOOK_MIN_QUALITY_SCORE: process.env.MOLTBOOK_MIN_QUALITY_SCORE ?? "7",
  },

  /**
   * Plugin initialization - runs once at startup.
   *
   * WHY AN INIT FUNCTION?
   * - Validate configuration early (fail fast)
   * - Display banner so operators know plugin loaded
   * - Set up any process-level config (env vars)
   *
   * NOTE: This runs BEFORE services are started. Don't do heavy async work here.
   */
  async init(config: Record<string, string>, runtime) {
    // Display startup banner with current settings
    // WHY? Operators need visual confirmation plugin loaded correctly.
    // Showing settings (masked for secrets) aids debugging.
    const settings: PluginSetting[] = [
      {
        name: "MOLTBOOK_API_KEY",
        value: runtime.getSetting("MOLTBOOK_API_KEY"),
        sensitive: true, // Mask in logs
      },
      {
        name: "MOLTBOOK_AUTO_REGISTER",
        value: runtime.getSetting("MOLTBOOK_AUTO_REGISTER"),
        defaultValue: "true",
      },
      {
        name: "MOLTBOOK_AUTO_ENGAGE",
        value: runtime.getSetting("MOLTBOOK_AUTO_ENGAGE"),
        defaultValue: "false",
      },
      {
        name: "MOLTBOOK_MIN_QUALITY_SCORE",
        value: runtime.getSetting("MOLTBOOK_MIN_QUALITY_SCORE"),
        defaultValue: "7",
      },
    ];

    printBanner({ runtime, settings });

    // Validate configuration using Zod schema
    // WHY VALIDATE? Catch config errors early with clear messages.
    // Better than cryptic failures deep in service code.
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set validated values as env vars for consistency
      // WHY? Some code reads process.env directly. This ensures consistency.
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages =
          error.issues?.map((e) => e.message)?.join(", ") || "Unknown validation error";
        throw new Error(`Invalid plugin configuration: ${errorMessages}`);
      }
      throw new Error(
        `Invalid plugin configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },

  /**
   * Services - long-running stateful components.
   *
   * MoltbookService handles:
   * - Authentication and credential management
   * - API communication with rate limiting
   * - Background task scheduling
   */
  services: [MoltbookService as any],

  /**
   * Actions - things the agent can DO.
   *
   * Each action has:
   * - name: How the agent refers to it
   * - description: Helps LLM understand when to use it
   * - validate(): Is this action available now?
   * - handler(): Execute the action
   *
   * Core 1.x actions with quality gating:
   * - post, comment, vote, follow, browse, search
   *
   * Additional convenience actions:
   * - moltbookRead: Read full post with comments in one call
   * - moltbookSubmolts: List/examine submolts (subreddits for AI agents)
   */
  actions: [
    postAction,
    commentAction,
    voteAction,
    followAction,
    browseAction,
    searchAction,
    moltbookReadAction,
    moltbookSubmoltsAction,
  ],

  /**
   * Providers - context injected into agent prompts.
   *
   * Three tiers for different context budgets:
   * - LOW (~100 tokens): Just status - "Can I post?"
   * - MEDIUM (~300 tokens): Status + topics + vibe - "What's happening?"
   * - HIGH (~800 tokens): Full analysis - "Deep community insights"
   *
   * WHY MULTIPLE TIERS? LLM context is limited. Simple tasks shouldn't
   * waste tokens on full analysis. Complex tasks need more context.
   * Let the task planner choose based on the situation.
   */
  providers: [
    moltbookStatusProvider, // LOW: ~100 tokens - just auth/rate limits
    moltbookContextProvider, // MEDIUM: ~300 tokens - status + topics + vibe
    moltbookFullAnalysisProvider, // HIGH: ~800 tokens - full analysis
  ],

  /**
   * Evaluators - post-interaction processing for learning.
   *
   * WHY EVALUATORS? Evaluators run AFTER interactions, enabling:
   * - Learning from engagement outcomes
   * - Tracking relationships with community members
   * - Refining cultural understanding
   * - Improving future behavior based on feedback
   */
  evaluators: [reflectionEvaluator],

  // NOTE: Tasks are registered via TaskWorker in the service, not here.
  // WHY? Tasks need the service to be running first. The service
  // registers the MOLTBOOK_CYCLE task worker after initialization.
};

export default moltbookPlugin;
