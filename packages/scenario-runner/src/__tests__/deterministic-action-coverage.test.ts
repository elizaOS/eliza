/**
 * Deterministic action-coverage gate.
 *
 * The app exposes an action surface that we want exercised by zero-cost
 * (keyless) e2e scenarios in CI. This test keeps that promise honest:
 *
 *   - Surface integrity: the real action surface of each importable core plugin
 *     is read live (from `plugin.actions[].name`) and must match the checked-in
 *     manifest. A new/renamed/removed action breaks the build, forcing whoever
 *     changed it to acknowledge the action here.
 *   - Coverage registry: every action we claim to cover deterministically must
 *     still be referenced by a real scenario (no silent coverage regression),
 *     and the total only grows (count ratchet).
 *   - Stable-core ratchet: every stable-core keyless action is either covered or
 *     in a baseline that may only shrink.
 *   - Wiring integrity: every scenario file is actually run by the deterministic
 *     CI script — a scenario that exists but never runs is larp.
 *
 * Plugins import is static (top of file) so the heavy source transform happens
 * at module load, not inside a test where it would race the per-test timeout.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@elizaos/core";
import agentSkillsPlugin from "@elizaos/plugin-agent-skills";
import appControlPlugin from "@elizaos/plugin-app-control";
import codingToolsPlugin from "@elizaos/plugin-coding-tools";
import commandsPlugin from "@elizaos/plugin-commands";
import facewearPlugin from "@elizaos/plugin-facewear";
import githubPlugin from "@elizaos/plugin-github";
import gitPathologyPlugin from "@elizaos/plugin-gitpathologist";
import localInferencePlugin from "@elizaos/plugin-local-inference";
import deviceFilesystemPlugin from "@elizaos/plugin-native-filesystem";
import shellPlugin from "@elizaos/plugin-shell";
import streamingPlugin from "@elizaos/plugin-streaming";
import todosPlugin from "@elizaos/plugin-todos";
import videoPlugin from "@elizaos/plugin-video";
import workflowPlugin from "@elizaos/plugin-workflow";
import type { ScenarioTurn } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import mcpPlugin from "../../../../plugins/plugin-mcp/src/index.ts";
import { loadAllScenarios } from "../loader";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const scenarioDir = resolve(
  repoRoot,
  "packages/scenario-runner/test/scenarios",
);

/** Stable core plugins whose action surface is read live by import. */
const IMPORTED_CORE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-app-control": appControlPlugin,
  "@elizaos/plugin-coding-tools": codingToolsPlugin,
  "@elizaos/plugin-commands": commandsPlugin,
  "@elizaos/plugin-agent-skills": agentSkillsPlugin,
  "@elizaos/plugin-local-inference": localInferencePlugin,
  "@elizaos/plugin-gitpathologist": gitPathologyPlugin,
  "@elizaos/plugin-todos": todosPlugin,
  "@elizaos/plugin-streaming": streamingPlugin,
  "@elizaos/plugin-facewear": facewearPlugin,
  "@elizaos/plugin-mcp": mcpPlugin,
  "@elizaos/plugin-workflow": workflowPlugin,
  "@elizaos/plugin-github": githubPlugin,
};

/** Expected action names for each imported core plugin (verified against live imports). */
const CORE_ACTION_SURFACE: Record<string, readonly string[]> = {
  "@elizaos/plugin-app-control": [
    "AGENT_SWITCH",
    "APP",
    "BACKGROUND",
    "MODEL_SWITCH",
    "SETTINGS",
    "VIEWS",
  ],
  "@elizaos/plugin-coding-tools": ["FILE", "SHELL", "WORKTREE"],
  "@elizaos/plugin-commands": [
    "ACCOUNTS_COMMAND",
    "BACKEND_COMMAND",
    "COMMANDS_COMMAND",
    "COMPACT_COMMAND",
    "CONTEXT_COMMAND",
    "ELEVATED_COMMAND",
    "HELP_COMMAND",
    "MODEL_COMMAND",
    "NEW_COMMAND",
    "QUEUE_COMMAND",
    "REASONING_COMMAND",
    "RESET_COMMAND",
    "STATUS_COMMAND",
    "THINK_COMMAND",
    "TTS_COMMAND",
    "USAGE_COMMAND",
    "VERBOSE_COMMAND",
    "WHOAMI_COMMAND",
  ],
  "@elizaos/plugin-agent-skills": [
    "SKILL",
    "SKILL_DETAILS",
    "SKILL_INSTALL",
    "SKILL_SEARCH",
    "SKILL_SYNC",
    "SKILL_TOGGLE",
    "SKILL_UNINSTALL",
    "USE_SKILL",
  ],
  "@elizaos/plugin-local-inference": [
    "GENERATE_MEDIA",
    "IDENTIFY_SPEAKER",
    "LOCAL_INFERENCE",
    "REDACT_TRANSCRIPT",
    "SHARE_TRANSCRIPT",
    "START_TRANSCRIPTION",
    "STOP_TRANSCRIPTION",
  ],
  "@elizaos/plugin-gitpathologist": ["GIT_PATHOLOGY"],
  "@elizaos/plugin-todos": ["TODO"],
  "@elizaos/plugin-streaming": ["STREAM"],
  "@elizaos/plugin-facewear": [
    "FACEWEAR_CONNECT",
    "FACEWEAR_DEBUG",
    "SMARTGLASSES_CONTROL",
    "SMARTGLASSES_DISPLAY_TEXT",
    "SMARTGLASSES_MICROPHONE",
    "SMARTGLASSES_STATUS",
  ],
  "@elizaos/plugin-mcp": [
    "MCP",
    "MCP_CALL_TOOL",
    "MCP_LIST_CONNECTIONS",
    "MCP_READ_RESOURCE",
    "MCP_SEARCH_ACTIONS",
  ],
  "@elizaos/plugin-workflow": ["EVAL_CODE", "WORKFLOW"],
  "@elizaos/plugin-github": [
    "GITHUB",
    "GITHUB_ISSUE_ASSIGN",
    "GITHUB_ISSUE_CLOSE",
    "GITHUB_ISSUE_COMMENT",
    "GITHUB_ISSUE_CREATE",
    "GITHUB_ISSUE_LABEL",
    "GITHUB_ISSUE_REOPEN",
    "GITHUB_NOTIFICATION_TRIAGE",
    "GITHUB_PR_LIST",
    "GITHUB_PR_REVIEW",
  ],
};

/** Core plugins that intentionally expose no agent actions (service/registry only). */
const ACTIONLESS_CORE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-shell": shellPlugin,
  "@elizaos/plugin-video": videoPlugin,
  "@elizaos/plugin-native-filesystem": deviceFilesystemPlugin,
};

/**
 * Core plugin actions that the keyless lane resolves from source instead of a
 * live import: the app-control VIEWS aliases are wired in source but are not
 * registered as top-level runtime actions in this lane, so the live action
 * surface never exposes them. Verified by source instead.
 */
const SOURCE_ONLY_ACTIONS: Record<string, readonly string[]> = {
  "plugins/plugin-app-control/src/actions/views.ts": [
    "CLOSE_ALL_VIEWS",
    "CLOSE_VIEW",
  ],
};

/**
 * These actions are wired by source, but package resolution can read either
 * stale local dist or source in different CI lanes. Verify them from source and
 * exclude them from the live import drift check so both environments enforce
 * the same action contract.
 */
const SOURCE_VERIFIED_IMPORTED_ACTIONS: Record<string, readonly string[]> = {
  "@elizaos/plugin-app-control": ["CLOSE_ALL_VIEWS", "CLOSE_VIEW"],
};

/**
 * The stable-core keyless surface that the ratchet drives to completion: the
 * importable core plugins plus the source-only VIEWS aliases. Big, volatile
 * surfaces (browser, lifeops) are NOT here — their coverage is tracked by the
 * coverage registry instead, so adding a lifeops scenario never has to edit a
 * 150-entry surface list.
 */
function stableCoreActions(): string[] {
  return sorted([
    ...Object.values(CORE_ACTION_SURFACE).flat(),
    ...Object.values(SOURCE_ONLY_ACTIONS).flat(),
  ]);
}

/**
 * Stable imported keyless actions that do NOT yet have a deterministic scenario.
 * This baseline may only shrink: cover one and delete it here; add a new
 * stable-core action and either cover it or add it here.
 */
const KNOWN_UNCOVERED: readonly string[] = [
  // Source wires these VIEWS aliases, but this keyless E2E lane resolves the
  // current runtime action surface without registering them as top-level actions.
  "CLOSE_ALL_VIEWS",
  "CLOSE_VIEW",
  // New speaker-diarization action; no deterministic keyless scenario yet.
  "IDENTIFY_SPEAKER",
  // New on-device transcription actions; no deterministic keyless scenario yet.
  "START_TRANSCRIPTION",
  "STOP_TRANSCRIPTION",
  // Transcript permissioning actions (#15606); no deterministic keyless
  // scenario yet.
  "REDACT_TRANSCRIPT",
  "SHARE_TRANSCRIPT",
  // New workflow code-eval action (#8914); no deterministic keyless scenario yet.
  "EVAL_CODE",
  // App-control agent/model switchers + settings surface; dispatched through
  // dashboard affordances, no deterministic keyless scenarios yet.
  "AGENT_SWITCH",
  "MODEL_SWITCH",
  "SETTINGS",
  // Local-inference management action; no deterministic keyless scenario yet.
  "LOCAL_INFERENCE",
  // Facewear owns smartglasses connection/runtime actions. The device-facing
  // actions need dedicated keyless scenarios before they can leave this
  // baseline.
  "FACEWEAR_CONNECT",
  "FACEWEAR_DEBUG",
  "SMARTGLASSES_CONTROL",
  "SMARTGLASSES_DISPLAY_TEXT",
  "SMARTGLASSES_MICROPHONE",
  "SMARTGLASSES_STATUS",
  // plugin-commands slash-command actions (/help, /status, /reset, /compact,
  // /think, /model, /tts, …) are dispatched through the command palette, not
  // the keyless scenario pipeline, so they have no deterministic scenario yet.
  "ACCOUNTS_COMMAND",
  "BACKEND_COMMAND",
  "COMMANDS_COMMAND",
  "COMPACT_COMMAND",
  "CONTEXT_COMMAND",
  "ELEVATED_COMMAND",
  "HELP_COMMAND",
  "MODEL_COMMAND",
  "NEW_COMMAND",
  "QUEUE_COMMAND",
  "REASONING_COMMAND",
  "RESET_COMMAND",
  "STATUS_COMMAND",
  "THINK_COMMAND",
  "TTS_COMMAND",
  "USAGE_COMMAND",
  "VERBOSE_COMMAND",
  "WHOAMI_COMMAND",
];

/**
 * Actions with deterministic keyless scenario coverage today. This is the
 * registry that must not regress: every entry must still be referenced by a
 * scenario. It includes actions from volatile plugins (browser web mode,
 * lifeops scheduled tasks) that are NOT in the stable-core surface above.
 */
const COVERED_ACTIONS: readonly string[] = [
  "APP",
  "BACKGROUND",
  "BROWSER_CLICK",
  "BROWSER_CLOSE",
  "BROWSER_GET",
  "BROWSER_LIST_TABS",
  "BROWSER_OPEN",
  "BROWSER_SCREENSHOT",
  "BROWSER_TYPE",
  "BROWSER_WAIT",
  "FILE",
  "GENERATE_MEDIA",
  "GIT_PATHOLOGY",
  "GITHUB",
  "GITHUB_ISSUE_ASSIGN",
  "GITHUB_ISSUE_CLOSE",
  "GITHUB_ISSUE_COMMENT",
  "GITHUB_ISSUE_CREATE",
  "GITHUB_ISSUE_LABEL",
  "GITHUB_ISSUE_REOPEN",
  "GITHUB_NOTIFICATION_TRIAGE",
  "GITHUB_PR_LIST",
  "GITHUB_PR_REVIEW",
  "MCP",
  "MCP_CALL_TOOL",
  "MCP_LIST_CONNECTIONS",
  "MCP_READ_RESOURCE",
  "MCP_SEARCH_ACTIONS",
  "SKILL",
  "SKILL_DETAILS",
  "SKILL_INSTALL",
  "SKILL_SEARCH",
  "SKILL_SYNC",
  "SKILL_TOGGLE",
  "SKILL_UNINSTALL",
  "SHELL",
  "SCHEDULED_TASKS",
  "STREAM",
  "TODO",
  "USE_SKILL",
  "VIEWS",
  "WORKTREE",
  "WORKFLOW",
];

/** Deterministic coverage only grows: distinct covered actions must stay >= this. */
const COVERED_FLOOR = COVERED_ACTIONS.length;

/**
 * Plugins whose remaining action surface needs live credentials, a real
 * browser, or a local model. Documented for honesty; the keyless mock LLM
 * cannot stand in for these without faking the integration. Note that browser
 * (web/JSDOM mode) and lifeops (scheduled tasks) ARE partially keyless-covered
 * — see COVERED_ACTIONS — so the reason describes only the remainder.
 */
const LIVE_ONLY_REMAINDER: Record<string, string> = {
  "@elizaos/plugin-personal-assistant":
    "Beyond SCHEDULED_TASKS, actions need live connector creds (Gmail, calendar, messaging, owner data).",
  "@elizaos/plugin-browser":
    "Beyond web/JSDOM mode, actions need a real Chromium session or browser bridge.",
  "@elizaos/plugin-agent-orchestrator":
    "TASKS (+ TASKS_* virtuals) spawns and drives ACP coding sub-agents over PTY; the keyless mock cannot stand in for real sub-agent processes. Unit-covered in plugins/plugin-agent-orchestrator/__tests__.",
};

/**
 * Source-derived umbrella-action surface for the three booted plugins that the
 * gate deliberately does NOT live-import (their full surface is large, platform-
 * gated, and credential-heavy — see LIVE_ONLY_REMAINDER). Live import is the
 * wrong tool here: google needs OAuth, lifeops promotes a platform-dependent set
 * (`OWNER_SCREENTIME` only exists on darwin) and pulls `messagingTriageActions`
 * in from @elizaos/core, and browser needs a real Chromium/JSDOM stack.
 *
 * Without this manifest, adding a NEW action to one of these plugins would slip
 * through silently — it is neither live-imported (so CORE_ACTION_SURFACE can't
 * catch it) nor source-enumerated. This closes that gap by pinning the umbrella
 * action names each plugin declares in its own source. It is a drift-
 * acknowledgment surface, NOT a keyless-coverage mandate: a new umbrella forces
 * the author to classify it (cover its keyless slice in COVERED_ACTIONS, or
 * extend the LIVE_ONLY_REMAINDER justification) — it does not demand a scenario.
 *
 * Each umbrella's promoted virtuals (`BROWSER_CLICK`, `BLOCK_LIST_ACTIVE`, ...)
 * are intentionally out of scope: their names are derived at runtime by
 * `promoteSubactionsToActions` from a discriminator enum, so enumerating them
 * from source would mean re-implementing that transform here. The umbrella set
 * is the right-sized signal — a brand-new action is always a new umbrella
 * (`const ACTION_NAME = "X"` or a top-level `name: "X"`), which this catches.
 *
 * `files` lists exactly the action sources each plugin wires into its `actions`
 * array (verified against each plugin's entry). `actions` is the umbrella-name
 * set those files declare. Google wires `actions: []`, so its set is empty and
 * the empty-array literal is asserted to stay put.
 */
const BOOTED_PLUGIN_ACTION_SURFACE: Record<
  string,
  { files: readonly string[]; actions: readonly string[] }
> = {
  "@elizaos/plugin-google": {
    files: ["plugins/plugin-google/src/index.ts"],
    actions: [],
  },
  "@elizaos/plugin-browser": {
    files: [
      "plugins/plugin-browser/src/actions/browser.ts",
      "plugins/plugin-browser/src/actions/manage-browser-bridge.ts",
    ],
    actions: ["BROWSER", "MANAGE_BROWSER_BRIDGE"],
  },
  "@elizaos/plugin-personal-assistant": {
    files: [
      "plugins/plugin-personal-assistant/src/actions/block.ts",
      "plugins/plugin-personal-assistant/src/actions/brief.ts",
      "plugins/plugin-personal-assistant/src/actions/calendar.ts",
      "plugins/plugin-personal-assistant/src/actions/conflict-detect.ts",
      "plugins/plugin-personal-assistant/src/actions/connector.ts",
      "plugins/plugin-personal-assistant/src/actions/credentials.ts",
      "plugins/plugin-personal-assistant/src/actions/document.ts",
      "plugins/plugin-personal-assistant/src/actions/entity.ts",
      "plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts",
      "plugins/plugin-personal-assistant/src/actions/prioritize.ts",
      "plugins/plugin-personal-assistant/src/actions/resolve-request.ts",
      "plugins/plugin-personal-assistant/src/actions/scheduled-task.ts",
      "plugins/plugin-personal-assistant/src/actions/voice-call.ts",
      "plugins/plugin-personal-assistant/src/actions/work-thread.ts",
    ],
    actions: [
      "BLOCK",
      "BRIEF",
      "CALENDAR",
      "CONFLICT_DETECT",
      "CONNECTOR",
      "CREDENTIALS",
      "ENTITY",
      "OWNER_ALARMS",
      "OWNER_DOCUMENTS",
      "OWNER_FINANCES",
      "OWNER_GOALS",
      "OWNER_REMINDERS",
      "OWNER_ROUTINES",
      "OWNER_TODOS",
      "PERSONAL_ASSISTANT",
      "PRIORITIZE",
      "RESOLVE_REQUEST",
      "SCHEDULED_TASKS",
      "VOICE_CALL",
      "WORK_THREAD",
    ],
  },
};

type AppControlActionName = "APP" | "VIEWS";

/**
 * APP/VIEWS are intentionally unified actions, so top-level action-name
 * coverage is too coarse. This live-schema manifest fails when app-control
 * adds or removes a supported action mode.
 */
const APP_CONTROL_MODE_SURFACE: Record<
  AppControlActionName,
  readonly string[]
> = {
  APP: ["create", "launch", "list", "load_from_directory", "relaunch"],
  VIEWS: [
    "broadcast",
    "close",
    "create",
    "current",
    "delete",
    "edit",
    "icon",
    "interact",
    "list",
    "manager",
    "open",
    "pin",
    "remove",
    "rollback",
    "search",
    "show",
    "split",
    "tile",
    "window",
  ],
};

/**
 * Remaining APP/VIEWS modes without direct deterministic action turns. This
 * baseline may only shrink. The high-risk management modes below it are
 * covered by asserted turns and cannot be represented by helper strings.
 */
// VIEWS:close/split/tile are now exercised by real scenario turns (the coverage
// loader reports zero uncovered modes), so the known-uncovered baseline is empty.
// Re-add a mode here only if its real scenario turn is intentionally removed.
const KNOWN_UNCOVERED_APP_CONTROL_MODES: readonly string[] = [
  // New VIEWS:rollback mode (live action schema) has no deterministic scenario
  // turn yet; tracked here so the coverage loader stays green until one lands.
  "VIEWS:rollback",
];

const REQUIRED_APP_CONTROL_MODE_TURNS: readonly {
  actionName: AppControlActionName;
  mode: string;
  label: string;
  requiredOptions?: Record<string, (value: unknown) => boolean>;
}[] = [
  {
    actionName: "APP",
    mode: "list",
    label: "APP list installed/running apps",
  },
  {
    actionName: "APP",
    mode: "launch",
    label: "APP launch",
    requiredOptions: { app: isNonEmptyString },
  },
  {
    actionName: "APP",
    mode: "relaunch",
    label: "APP relaunch",
    requiredOptions: { app: isNonEmptyString },
  },
  {
    actionName: "APP",
    mode: "load_from_directory",
    label: "APP load_from_directory",
    requiredOptions: { directory: isNonEmptyString },
  },
  {
    actionName: "APP",
    mode: "create",
    label: "APP create/edit existing app",
    requiredOptions: {
      editTarget: isNonEmptyString,
      intent: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "list",
    label: "VIEWS list",
  },
  {
    actionName: "VIEWS",
    mode: "search",
    label: "VIEWS search",
    requiredOptions: { query: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "show",
    label: "VIEWS show",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "open",
    label: "VIEWS open alias",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "current",
    label: "VIEWS current view",
  },
  {
    actionName: "VIEWS",
    mode: "manager",
    label: "VIEWS manager",
  },
  {
    actionName: "VIEWS",
    mode: "broadcast",
    label: "VIEWS broadcast event",
    requiredOptions: { eventType: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "interact",
    label: "VIEWS mounted-view interact",
    requiredOptions: {
      capability: isNonEmptyString,
      view: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "pin",
    label: "VIEWS pin desktop tab",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "window",
    label: "VIEWS detached window",
    requiredOptions: { view: isNonEmptyString },
  },
  {
    actionName: "VIEWS",
    mode: "create",
    label: "VIEWS create-mode edit existing view",
    requiredOptions: {
      editTarget: isNonEmptyString,
      intent: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "edit",
    label: "VIEWS direct edit",
    requiredOptions: {
      intent: isNonEmptyString,
      view: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "delete",
    label: "VIEWS confirmed delete",
    requiredOptions: {
      confirm: (value) => value === "true" || value === "yes",
      view: isNonEmptyString,
    },
  },
  {
    actionName: "VIEWS",
    mode: "remove",
    label: "VIEWS remove alias",
    requiredOptions: {
      confirm: (value) => value === "true" || value === "yes",
      view: isNonEmptyString,
    },
  },
];

const REQUIRED_APP_CONTROL_NL_TURNS: readonly string[] = [
  "natural language opens a view",
  "natural language searches views",
  "natural language launches an app",
  "natural language relaunches an app",
  "natural language loads apps from directory",
  "natural language enters app create choice flow",
  "natural language cancels pending app create flow",
  "natural language edits a view",
  "natural language edits an app",
  "natural language deletes a view with explicit confirmation",
];

/**
 * Actions that are currently exercised through real message turns using the
 * strict deterministic LLM proxy. This is intentionally separate from
 * COVERED_ACTIONS: most deterministic coverage is still direct handler
 * coverage, which is useful but must not be reported as NL routing coverage.
 */
const STRICT_LLM_ROUTED_ACTIONS: readonly string[] = [
  "APP",
  "BROWSER_CLICK",
  "BROWSER_CLOSE",
  "BROWSER_GET",
  "BROWSER_LIST_TABS",
  "BROWSER_OPEN",
  "BROWSER_SCREENSHOT",
  "BROWSER_TYPE",
  "BROWSER_WAIT",
  "FILE",
  "GENERATE_MEDIA",
  "GITHUB",
  "GITHUB_ISSUE_ASSIGN",
  "GITHUB_ISSUE_CLOSE",
  "GITHUB_ISSUE_COMMENT",
  "GITHUB_ISSUE_CREATE",
  "GITHUB_ISSUE_LABEL",
  "GITHUB_ISSUE_REOPEN",
  "GITHUB_NOTIFICATION_TRIAGE",
  "GITHUB_PR_LIST",
  "GITHUB_PR_REVIEW",
  "GIT_PATHOLOGY",
  "MCP",
  "MCP_CALL_TOOL",
  "MCP_LIST_CONNECTIONS",
  "MCP_READ_RESOURCE",
  "MCP_SEARCH_ACTIONS",
  "SCHEDULED_TASKS",
  "SHELL",
  "SKILL",
  "SKILL_DETAILS",
  "SKILL_INSTALL",
  "SKILL_SEARCH",
  "SKILL_SYNC",
  "SKILL_TOGGLE",
  "SKILL_UNINSTALL",
  "STREAM",
  "TODO",
  "USE_SKILL",
  "VIEWS",
  "WORKTREE",
  "WORKFLOW",
];

const STRICT_LLM_ROUTING_SCENARIOS: Record<
  string,
  {
    actionNames: readonly string[];
    minMessageTurns: number;
  }
> = {
  "deterministic-app-control-nl-routing": {
    actionNames: ["APP", "VIEWS"],
    minMessageTurns: REQUIRED_APP_CONTROL_NL_TURNS.length,
  },
  "deterministic-active-view-agent-surface": {
    actionNames: ["VIEWS"],
    minMessageTurns: 2,
  },
  // live-only lane, but it pins ACTION_PLANNER fixtures for its VIEWS turn, so
  // it satisfies the strict fixture contract and is classified here rather
  // than the no-deterministic-fixture bucket.
  "live-active-view-agent-surface": {
    actionNames: ["VIEWS"],
    minMessageTurns: 1,
  },
  "deterministic-agent-skills-actions": {
    actionNames: [
      "SKILL",
      "SKILL_DETAILS",
      "SKILL_INSTALL",
      "SKILL_SEARCH",
      "SKILL_SYNC",
      "SKILL_TOGGLE",
      "SKILL_UNINSTALL",
      "USE_SKILL",
    ],
    minMessageTurns: 9,
  },
  "deterministic-browser-actions": {
    actionNames: [
      "BROWSER_CLICK",
      "BROWSER_CLOSE",
      "BROWSER_GET",
      "BROWSER_LIST_TABS",
      "BROWSER_OPEN",
      "BROWSER_SCREENSHOT",
      "BROWSER_TYPE",
      "BROWSER_WAIT",
    ],
    minMessageTurns: 8,
  },
  "deterministic-coding-tools-actions": {
    actionNames: ["FILE", "SHELL", "WORKTREE"],
    minMessageTurns: 5,
  },
  "deterministic-github-actions-routes": {
    actionNames: [
      "GITHUB",
      "GITHUB_ISSUE_ASSIGN",
      "GITHUB_ISSUE_CLOSE",
      "GITHUB_ISSUE_COMMENT",
      "GITHUB_ISSUE_CREATE",
      "GITHUB_ISSUE_LABEL",
      "GITHUB_ISSUE_REOPEN",
      "GITHUB_NOTIFICATION_TRIAGE",
      "GITHUB_PR_LIST",
      "GITHUB_PR_REVIEW",
    ],
    minMessageTurns: 11,
  },
  "deterministic-gitpathology-actions": {
    actionNames: ["GIT_PATHOLOGY"],
    minMessageTurns: 1,
  },
  "deterministic-media-actions": {
    actionNames: ["GENERATE_MEDIA"],
    minMessageTurns: 2,
  },
  "deterministic-lifeops-multiday-journey": {
    actionNames: ["SCHEDULED_TASKS"],
    minMessageTurns: 5,
  },
  "deterministic-lifeops-scheduled-tasks": {
    actionNames: ["SCHEDULED_TASKS"],
    minMessageTurns: 6,
  },
  "deterministic-mcp-actions-routes": {
    actionNames: [
      "MCP",
      "MCP_CALL_TOOL",
      "MCP_LIST_CONNECTIONS",
      "MCP_READ_RESOURCE",
      "MCP_SEARCH_ACTIONS",
    ],
    minMessageTurns: 5,
  },
  "deterministic-streaming-actions": {
    actionNames: ["STREAM"],
    minMessageTurns: 4,
  },
  "deterministic-todos-actions": {
    actionNames: ["TODO"],
    minMessageTurns: 1,
  },
  "deterministic-workflow-actions-routes": {
    actionNames: ["WORKFLOW"],
    minMessageTurns: 1,
  },
};

const PROSE_ONLY_LLM_SCENARIOS: Record<string, string> = {
  "deterministic-pr-smoke":
    "single TEXT_SMALL deterministic reply smoke; it does not route an action",
  "deterministic-inbound-attachment-actions":
    "inbound attachment flows through the pipeline to a deterministic reply; it does not route an action (the read tool is core ATTACHMENT, unit-tested in core)",
  "live-inbound-attachment":
    "live-lane real-LLM counterpart of deterministic-inbound-attachment-actions; the model reads the attachment and replies in prose, routing no action",
  "cloud-apps-read-core":
    "live-only real-LLM trajectory exercising LIST_CLOUD_APPS against the real Cloud API (#10277); it routes via the live model, NOT a deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract and is classified here (the no-deterministic-fixture bucket). Its gating proof is the keyless bun:test suite in plugins/plugin-cloud-apps/__tests__.",
  "background-live":
    "live-only real-LLM counterpart of deterministic-background-actions (#10694); a real model routes set/undo/redo/reset to BACKGROUND from natural phrasing, NOT a deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract and is classified here (the no-deterministic-fixture bucket). Its keyless gating proof is deterministic-background-actions in the pr-deterministic lane.",
  "live-background-actions":
    "live-only real-LLM counterpart of deterministic-background-actions (#10694); the live model routes BACKGROUND (color set, GLSL preset, undo) with no deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract. The deterministic twin pins the exact payload ledger on the keyless lane.",
  "live-chat-widgets-choice-roundtrip":
    "live-only real-LLM chat-widget choice roundtrip; widget emission/interaction is judged from the live reply with no deterministic ACTION_PLANNER fixture. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-chat-widgets-config-emission":
    "live-only real-LLM chat-widget config emission; prose+widget reply, routes no deterministic fixture action. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-chat-widgets-followups-restraint":
    "live-only real-LLM followups-restraint check; asserts the live reply withholds widgets, routing no action. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-chat-widgets-form-roundtrip":
    "live-only real-LLM chat-widget form roundtrip; widget emission/interaction is judged from the live reply with no deterministic ACTION_PLANNER fixture. Keyless gating proof: the chat-widget unit + fixture e2e suites in packages/ui.",
  "live-experience-delete-by-topic":
    "live-only real-LLM EXPERIENCE deletion flow; the live model routes EXPERIENCE with no deterministic ACTION_PLANNER fixture, so it cannot satisfy STRICT_LLM_ROUTING's fixture contract. Keyless gating proof: the experience service unit suites.",
  "live-help-knowledge":
    "live-only real-LLM help-knowledge lane (#14360); the model answers from bundled help documents in prose, routing no action.",
  "live-lifeops-task-filter-due-window":
    "live-only real-LLM counterpart of the deterministic lifeops scheduled-task lanes; the live model routes SCHEDULED_TASKS with no deterministic ACTION_PLANNER fixture. The deterministic twins gate the keyless lane.",
  "live-missing-input-terminal-relay":
    "live-only real-LLM missing-input planner-loop regression; the live model routes OWNER_REMINDERS without a deterministic ACTION_PLANNER fixture, while the keyless planner-loop suite forces the erroneous evaluator-CONTINUE branch.",
  "live-plugin-enable-toggle-verb":
    "live-only real-LLM plugin enable/toggle verb routing; no deterministic ACTION_PLANNER fixture. Keyless gating proof: plugin-manager action unit suites in core.",
  "live-workflow-action-executions":
    "live-only real-LLM counterpart of deterministic-workflow-actions-routes; the live model routes WORKFLOW with no deterministic ACTION_PLANNER fixture. The deterministic twin gates the keyless lane.",
};

/**
 * Covered actions that are not yet strict natural-language routed. This
 * baseline may only shrink as actions move to STRICT_LLM_ROUTED_ACTIONS.
 */
const DIRECT_ONLY_COVERED_ACTIONS: readonly string[] = ["BACKGROUND"];

function collectActionNames(plugin: Plugin): string[] {
  return sorted(
    (plugin.actions ?? [])
      .map((action) => action?.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Derives the umbrella action names a plugin declares from source, reading the
 * exact files it wires into its `actions` array. Matches the two forms these
 * plugins use to name an action: a `const ACTION_NAME = "X"` constant and a
 * top-level `name: "X"` literal. Action/umbrella names are UPPER_SNAKE, so the
 * UPPER-only match skips lowercase parameter names (`name: "action"`) and
 * `{{templated}}` example names without enumerating the promoted virtuals.
 */
function umbrellaActionNamesFromSource(files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const relPath of files) {
    const source = readFileSync(resolve(repoRoot, relPath), "utf8");
    for (const match of source.matchAll(
      /const\s+ACTION_NAME\s*=\s*"([A-Z][A-Z0-9_]*)"/g,
    )) {
      names.add(match[1]);
    }
    for (const match of source.matchAll(/\bname:\s*"([A-Z][A-Z0-9_]*)"/g)) {
      names.add(match[1]);
    }
  }
  return sorted(names);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionOptions(turn: ScenarioTurn): Record<string, unknown> {
  const options = toRecord(turn.options);
  const parameters = toRecord(options.parameters);
  return Object.keys(parameters).length > 0 ? parameters : options;
}

function readActionMode(turn: ScenarioTurn): string | null {
  const options = actionOptions(turn);
  const mode = options.action ?? options.mode;
  return isNonEmptyString(mode) ? mode.trim() : null;
}

function hasRequiredOptions(
  options: Record<string, unknown>,
  requirements: Record<string, (value: unknown) => boolean> | undefined,
): boolean {
  if (!requirements) return true;
  return Object.entries(requirements).every(([key, check]) =>
    check(options[key]),
  );
}

function appControlActionModes(actionName: AppControlActionName): string[] {
  const plugin = IMPORTED_CORE_PLUGINS["@elizaos/plugin-app-control"];
  const action = (plugin.actions ?? []).find(
    (candidate) => candidate.name === actionName,
  );
  const parameterWithEnum = (action?.parameters ?? []).find((param) => {
    if (param.name !== "action" && param.name !== "mode") return false;
    const schema = (param as { schema?: { enum?: unknown } }).schema;
    return Array.isArray(schema?.enum);
  }) as { schema?: { enum?: unknown } } | undefined;
  const modes = parameterWithEnum?.schema?.enum;
  const importedModes = Array.isArray(modes)
    ? modes.filter((mode): mode is string => typeof mode === "string")
    : [];
  const sourceModes =
    actionName === "VIEWS" ? appControlViewsModesFromSource() : [];
  return sorted([...importedModes, ...sourceModes]);
}

function appControlViewsModesFromSource(): string[] {
  const source = readFileSync(
    resolve(repoRoot, "plugins/plugin-app-control/src/actions/views.ts"),
    "utf8",
  );
  const modesMatch = source.match(
    /const\s+MODES:\s*readonly\s+ViewsMode\[\]\s*=\s*\[([\s\S]*?)\]\s+as\s+const;/,
  );
  if (!modesMatch?.[1]) return [];
  return sorted(
    [...modesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
}

async function scenarioActionModeTurns(): Promise<
  Array<{
    actionName: AppControlActionName;
    assertTurn: unknown;
    mode: string;
    options: Record<string, unknown>;
    scenarioId: string;
    turnName: string;
  }>
> {
  const turns: Array<{
    actionName: AppControlActionName;
    assertTurn: unknown;
    mode: string;
    options: Record<string, unknown>;
    scenarioId: string;
    turnName: string;
  }> = [];
  for (const { scenario } of await loadAllScenarios(scenarioDir)) {
    for (const turn of scenario.turns) {
      if (turn.kind !== "action") continue;
      const rawActionName = (turn as { actionName?: unknown }).actionName;
      if (rawActionName !== "APP" && rawActionName !== "VIEWS") continue;
      const actionName: AppControlActionName = rawActionName;
      const mode = readActionMode(turn);
      if (!mode) continue;
      turns.push({
        actionName,
        assertTurn: turn.assertTurn,
        mode,
        options: actionOptions(turn),
        scenarioId: scenario.id,
        turnName: turn.name,
      });
    }
  }
  return turns;
}

async function appControlNaturalLanguageTurnNames(): Promise<string[]> {
  const loaded = await loadAllScenarios(scenarioDir);
  const scenario = loaded.find(
    (entry) => entry.scenario.id === "deterministic-app-control-nl-routing",
  )?.scenario;
  if (!scenario) return [];
  return scenario.turns
    .filter(
      (turn) =>
        turn.kind === "message" && typeof turn.assertTurn === "function",
    )
    .map((turn) => turn.name);
}

function actionModeKey(actionName: AppControlActionName, mode: string): string {
  return `${actionName}:${mode}`;
}

function scenarioFiles(): string[] {
  return readdirSync(scenarioDir).filter((file) =>
    file.endsWith(".scenario.ts"),
  );
}

function collectActionNameValue(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    names.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === "string") names.add(entry);
  }
}

async function scenarioActionNames(): Promise<string[]> {
  const names = new Set<string>();
  for (const { scenario } of await loadAllScenarios(scenarioDir)) {
    for (const turn of scenario.turns) {
      if (turn.kind !== "action") continue;
      collectActionNameValue(
        (turn as { actionName?: unknown }).actionName,
        names,
      );
    }
    for (const check of scenario.finalChecks ?? []) {
      collectActionNameValue(
        (check as { actionName?: unknown }).actionName,
        names,
      );
    }
  }
  return sorted(names);
}

function declaredScenarioId(file: string): string | null {
  const source = readFileSync(resolve(scenarioDir, file), "utf8");
  return (
    source.match(/export\s+default\s+scenario\(\{\s*id:\s*"([^"]+)"/s)?.[1] ??
    null
  );
}

function scenarioSourceById(id: string): string | null {
  for (const file of scenarioFiles()) {
    const base = file.replace(/\.scenario\.ts$/, "");
    const declared = declaredScenarioId(file);
    if (declared === id || base === id) {
      return readFileSync(resolve(scenarioDir, file), "utf8");
    }
  }
  return null;
}

async function loadedScenarioById(id: string): Promise<{
  turns: readonly ScenarioTurn[];
} | null> {
  const loaded = await loadAllScenarios(scenarioDir);
  return loaded.find((entry) => entry.scenario.id === id)?.scenario ?? null;
}

function messageTurnCount(scenario: {
  turns: readonly ScenarioTurn[];
}): number {
  return scenario.turns.filter((turn) => turn.kind === "message").length;
}

async function messageScenarioIds(): Promise<string[]> {
  const loaded = await loadAllScenarios(scenarioDir);
  return sorted(
    loaded
      .filter(({ scenario }) => messageTurnCount(scenario) > 0)
      .map(({ scenario }) => scenario.id),
  );
}

// The deterministic CI run now selects by lane (`--lane pr-deterministic`)
// instead of a hand-maintained id list, so the "wired" set is every scenario
// file tagged `lane: "pr-deterministic"`.
function ciScenarioList(): string[] {
  return scenarioFiles()
    .filter((file) =>
      /lane:\s*["']pr-deterministic["']/.test(
        readFileSync(resolve(scenarioDir, file), "utf8"),
      ),
    )
    .map((file) => file.replace(/\.scenario\.ts$/, ""));
}

describe("deterministic action coverage", () => {
  it("stable-core plugin action surface matches the manifest (no drift, new actions caught)", () => {
    const drift: string[] = [];
    for (const [spec, plugin] of Object.entries(IMPORTED_CORE_PLUGINS)) {
      const sourceVerified = new Set(
        SOURCE_VERIFIED_IMPORTED_ACTIONS[spec] ?? [],
      );
      const actual = collectActionNames(plugin).filter(
        (name) => !sourceVerified.has(name),
      );
      const want = sorted(CORE_ACTION_SURFACE[spec] ?? []);
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        drift.push(
          `${spec}: real actions [${actual.join(", ")}] != manifest [${want.join(", ")}] — update CORE_ACTION_SURFACE or SOURCE_VERIFIED_IMPORTED_ACTIONS and classify any new action`,
        );
      }
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("service/registry core plugins expose no agent actions", () => {
    const unexpected: string[] = [];
    for (const [spec, plugin] of Object.entries(ACTIONLESS_CORE_PLUGINS)) {
      const actions = collectActionNames(plugin);
      if (actions.length > 0) {
        unexpected.push(`${spec}: now exposes [${actions.join(", ")}]`);
      }
    }
    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });

  it("source-only plugin actions are present in source", () => {
    const missing: string[] = [];
    for (const [relPath, actions] of Object.entries(SOURCE_ONLY_ACTIONS)) {
      const source = readFileSync(resolve(repoRoot, relPath), "utf8");
      for (const action of actions) {
        if (
          !source.includes(`name: "${action}"`) &&
          !source.includes(`"${action}"`)
        ) {
          missing.push(`${relPath}:${action}`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("booted-plugin umbrella action surface matches the manifest (new actions caught from source)", () => {
    const drift: string[] = [];
    for (const [spec, { files, actions }] of Object.entries(
      BOOTED_PLUGIN_ACTION_SURFACE,
    )) {
      const actual = umbrellaActionNamesFromSource(files);
      const want = sorted(actions);
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        drift.push(
          `${spec}: source umbrellas [${actual.join(", ") || "(none)"}] != manifest [${want.join(", ") || "(none)"}]\n` +
            `    A new/renamed/removed action in ${spec} must be classified: cover its keyless slice in COVERED_ACTIONS, ` +
            `or extend its LIVE_ONLY_REMAINDER justification — then update BOOTED_PLUGIN_ACTION_SURFACE to match.`,
        );
      }
    }
    // Google wires `actions: []`; assert the empty-array literal stays so the
    // empty manifest above can't be silently bypassed by wiring an action.
    const googleSource = readFileSync(
      resolve(repoRoot, "plugins/plugin-google/src/index.ts"),
      "utf8",
    );
    if (!/actions:\s*\[\s*\]/.test(googleSource)) {
      drift.push(
        "@elizaos/plugin-google: index.ts no longer declares `actions: []` — " +
          "it now wires an action surface that must be classified and added to BOOTED_PLUGIN_ACTION_SURFACE.",
      );
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("app-control APP/VIEWS mode surface matches the live action schemas", () => {
    const drift: string[] = [];
    for (const [actionName, expectedModes] of Object.entries(
      APP_CONTROL_MODE_SURFACE,
    ) as Array<[AppControlActionName, readonly string[]]>) {
      const actual = appControlActionModes(actionName);
      const expected = sorted(expectedModes);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        drift.push(
          `${actionName}: real modes [${actual.join(", ")}] != manifest [${expected.join(", ")}]`,
        );
      }
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("app-control APP/VIEWS mode coverage is loaded from real scenario turns", async () => {
    const turns = await scenarioActionModeTurns();
    const covered = new Set(
      turns.map((turn) => actionModeKey(turn.actionName, turn.mode)),
    );
    const liveModes = Object.entries(APP_CONTROL_MODE_SURFACE).flatMap(
      ([actionName, modes]) =>
        modes.map((mode) =>
          actionModeKey(actionName as AppControlActionName, mode),
        ),
    );
    const uncovered = liveModes.filter((key) => !covered.has(key));

    expect(
      sorted(uncovered),
      `APP/VIEWS mode coverage drifted.\n` +
        `  real uncovered: ${sorted(uncovered).join(", ") || "(none)"}\n` +
        `  baseline:       ${sorted(KNOWN_UNCOVERED_APP_CONTROL_MODES).join(", ") || "(none)"}`,
    ).toEqual(sorted(KNOWN_UNCOVERED_APP_CONTROL_MODES));
  });

  it("critical APP/VIEWS management modes have asserted deterministic action turns", async () => {
    const turns = await scenarioActionModeTurns();
    const missing = REQUIRED_APP_CONTROL_MODE_TURNS.filter((requirement) => {
      return !turns.some(
        (turn) =>
          turn.actionName === requirement.actionName &&
          turn.mode === requirement.mode &&
          typeof turn.assertTurn === "function" &&
          hasRequiredOptions(turn.options, requirement.requiredOptions),
      );
    }).map(
      (requirement) =>
        `${requirement.label} (${actionModeKey(requirement.actionName, requirement.mode)})`,
    );

    expect(
      missing,
      `critical APP/VIEWS modes must be backed by real loaded scenario turns with assertTurn checks: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("critical APP/VIEWS modes have asserted strict natural-language routing turns", async () => {
    const names = new Set(await appControlNaturalLanguageTurnNames());
    const missing = REQUIRED_APP_CONTROL_NL_TURNS.filter(
      (name) => !names.has(name),
    );

    expect(
      missing,
      `strict natural-language APP/VIEWS routing turns are missing assertTurn checks: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every deterministic message scenario is classified as strict-routed or prose-only", async () => {
    const actual = await messageScenarioIds();
    const expected = sorted([
      ...Object.keys(STRICT_LLM_ROUTING_SCENARIOS),
      ...Object.keys(PROSE_ONLY_LLM_SCENARIOS),
    ]);

    expect(
      actual,
      `message scenarios must be explicitly classified.\n` +
        `  actual:   ${actual.join(", ") || "(none)"}\n` +
        `  expected: ${expected.join(", ") || "(none)"}`,
    ).toEqual(expected);
  });

  it("strict LLM-routed scenarios declare planner/response fixtures for their routed actions", async () => {
    const problems: string[] = [];

    for (const [id, spec] of Object.entries(STRICT_LLM_ROUTING_SCENARIOS)) {
      const scenario = await loadedScenarioById(id);
      const source = scenarioSourceById(id);

      if (!scenario) {
        problems.push(`${id}: scenario is not loadable`);
        continue;
      }
      if (!source) {
        problems.push(`${id}: source file was not found`);
        continue;
      }
      // `_helpers/strict-llm-action-fixtures.ts` re-exports the canonical
      // template from `@elizaos/test-harness`; scenarios may also import the
      // stage1/planner fixture builders from that harness directly. Either
      // way, read the harness file for the fixture literals
      // (RESPONSE_HANDLER / ACTION_PLANNER / register call).
      const fixtureSource =
        source.includes("registerStrictActionRouteFixtures") ||
        source.includes("stage1ResponseHandlerFixture")
          ? `${source}\n${readFileSync(resolve(repoRoot, "packages/test/harness/action-route-fixtures.ts"), "utf8")}`
          : source;

      const messageTurns = messageTurnCount(scenario);
      if (messageTurns < spec.minMessageTurns) {
        problems.push(
          `${id}: expected at least ${spec.minMessageTurns} message turns, saw ${messageTurns}`,
        );
      }
      if (!/scenarioLlmFixtures\?\.register\(/.test(fixtureSource)) {
        problems.push(`${id}: no scenarioLlmFixtures.register call`);
      }
      if (!fixtureSource.includes("ModelType.RESPONSE_HANDLER")) {
        problems.push(`${id}: no RESPONSE_HANDLER fixture`);
      }
      if (!fixtureSource.includes("ModelType.ACTION_PLANNER")) {
        problems.push(`${id}: no ACTION_PLANNER fixture`);
      }
      for (const actionName of spec.actionNames) {
        if (!source.includes(`"${actionName}"`)) {
          problems.push(
            `${id}: source does not mention routed action ${actionName}`,
          );
        }
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("prose-only deterministic message scenarios do not declare action planner fixtures", () => {
    const problems: string[] = [];

    for (const id of Object.keys(PROSE_ONLY_LLM_SCENARIOS)) {
      const source = scenarioSourceById(id);
      if (!source) {
        problems.push(`${id}: source file was not found`);
        continue;
      }
      if (source.includes("ModelType.ACTION_PLANNER")) {
        problems.push(
          `${id}: classified as prose-only but declares ACTION_PLANNER fixtures`,
        );
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("covered actions that are not strict LLM-routed are an explicit direct-only baseline", () => {
    const covered = new Set(COVERED_ACTIONS);
    const strict = new Set(STRICT_LLM_ROUTED_ACTIONS);
    const missingStrict = STRICT_LLM_ROUTED_ACTIONS.filter(
      (name) => !covered.has(name),
    );
    const directOnly = sorted(
      COVERED_ACTIONS.filter((name) => !strict.has(name)),
    );

    expect(
      missingStrict,
      `STRICT_LLM_ROUTED_ACTIONS must be a subset of COVERED_ACTIONS: ${missingStrict.join(", ")}`,
    ).toEqual([]);
    expect(
      directOnly,
      `direct-only deterministic coverage drifted.\n` +
        `  real direct-only: ${directOnly.join(", ") || "(none)"}\n` +
        `  baseline:         ${sorted(DIRECT_ONLY_COVERED_ACTIONS).join(", ") || "(none)"}`,
    ).toEqual(sorted(DIRECT_ONLY_COVERED_ACTIONS));
  });

  it("every covered action still has a scenario (no coverage regression)", async () => {
    const covered = new Set(await scenarioActionNames());
    const regressed = sorted(COVERED_ACTIONS).filter(
      (name) => !covered.has(name),
    );
    expect(
      regressed,
      `actions in COVERED_ACTIONS no longer referenced by any scenario: ${regressed.join(", ")}`,
    ).toEqual([]);
  });

  it("deterministic coverage only grows (count ratchet)", async () => {
    const distinct = (await scenarioActionNames()).length;
    expect(
      distinct,
      `distinct covered actions dropped below the ratchet floor (${COVERED_FLOOR}); did a scenario get removed?`,
    ).toBeGreaterThanOrEqual(COVERED_FLOOR);
  });

  it("stable-core keyless actions are covered by a scenario or in the shrinking baseline", async () => {
    const covered = new Set(await scenarioActionNames());
    const uncovered = stableCoreActions().filter((name) => !covered.has(name));
    const baseline = sorted(KNOWN_UNCOVERED);

    expect(
      sorted(uncovered),
      `stable-core uncovered set drifted from KNOWN_UNCOVERED.\n` +
        `  real uncovered: ${sorted(uncovered).join(", ") || "(none)"}\n` +
        `  baseline:       ${baseline.join(", ") || "(none)"}`,
    ).toEqual(baseline);

    const known = new Set(stableCoreActions());
    const fake = baseline.filter((name) => !known.has(name));
    expect(
      fake,
      `baseline lists actions that are not in the stable-core surface: ${fake.join(", ")}`,
    ).toEqual([]);
  });

  it("every scenario file is wired into the deterministic CI run and named after its id", () => {
    const wired = new Set(ciScenarioList());
    const problems: string[] = [];
    for (const file of scenarioFiles()) {
      const base = file.replace(/\.scenario\.ts$/, "");
      const id = declaredScenarioId(file);
      if (id !== base) {
        problems.push(
          `${file}: declared id ${JSON.stringify(id)} != filename base ${JSON.stringify(base)}`,
        );
      }
      // Live-only counterparts (e.g. a real-LLM twin of a deterministic
      // scenario) live alongside their deterministic siblings but run in the
      // credentialed live lane, not the keyless deterministic CI lane — so they
      // are exempt from the pr-deterministic wiring requirement.
      const isLiveOnly = /lane:\s*["']live-only["']/.test(
        readFileSync(resolve(scenarioDir, file), "utf8"),
      );
      if (!isLiveOnly && !wired.has(base)) {
        problems.push(
          `${file}: missing 'lane: "pr-deterministic"' — tag it or it never runs in the deterministic CI lane`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("documents the live-only remainder without overlapping the keyless surface", () => {
    for (const reason of Object.values(LIVE_ONLY_REMAINDER)) {
      expect(reason.length).toBeGreaterThan(0);
    }
    const overlap = Object.keys(LIVE_ONLY_REMAINDER).filter(
      (spec) => spec in IMPORTED_CORE_PLUGINS,
    );
    expect(
      overlap,
      `plugin both keyless-imported and live-only: ${overlap.join(", ")}`,
    ).toEqual([]);
  });
});
