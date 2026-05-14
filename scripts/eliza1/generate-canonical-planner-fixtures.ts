#!/usr/bin/env bun
/**
 * generate-canonical-planner-fixtures — emit a planner fixture set whose
 * `availableActions` mirror the real canonical action surface from runtime
 * plugins (SHELL, FILE, TODO, PAYMENT, MUSIC, GITHUB, BROWSER, FORM, VISION,
 * WALLET, MCP, CREATE_LINEAR_ISSUE), instead of the synthetic
 * SEND_EMAIL/CREATE_REMINDER/etc. probes used by the hand-authored
 * `planner.json`. The synthetic set exercises parameter-extraction breadth;
 * this canonical set anchors the planner to the action vocabulary the runtime
 * actually exposes so regressions in real action discrimination are caught.
 *
 * Output: packages/benchmarks/eliza-1/src/fixtures/planner.canonical.json
 *
 * Source-of-truth contract:
 *   - This script is the source of truth for the JSON.
 *   - Action descriptors mirror the `name` + `descriptionCompressed` /
 *     `description` + scalar (`string` | `number` | `boolean`) `parameters`
 *     declared on the corresponding action source files. Non-scalar params
 *     (array / object) are dropped — `PlannerParameterDescriptor` only carries
 *     scalar shapes.
 *   - Cases (input + counter-prompt phrasing) are hand-authored constants in
 *     this file.
 *   - Output ordering is stable: actions sorted by name, cases sorted by id
 *     within each action. JSON is serialized with two-space indent and a
 *     trailing newline, byte-identical across consecutive runs.
 *
 * Usage:
 *   bun run scripts/eliza1/generate-canonical-planner-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// -------------------------------------------------------------------------
// Schema (mirrors packages/benchmarks/eliza-1/src/types.ts; replicated here
// to keep this script standalone — types live in the bench package and we
// only emit JSON from this side).
// -------------------------------------------------------------------------

type ScalarType = "string" | "number" | "boolean";

interface ParamDescriptor {
  name: string;
  type: ScalarType;
  description: string;
  enum?: string[];
  required?: boolean;
}

interface ActionDescriptor {
  name: string;
  description: string;
  parameters: ParamDescriptor[];
}

interface FixtureCase {
  id: string;
  input: string;
  availableActions: ActionDescriptor[];
  expected_action_name: string;
  expected_params: Record<string, string | number | boolean>;
  notes?: string;
}

// -------------------------------------------------------------------------
// Canonical action descriptors. Each block lifts `name` + `descriptionCompressed`
// (preferred) or `description` + scalar parameter rows from the real source
// file referenced in the comment. Source files were verified against the
// monorepo at HEAD of the develop branch on the day this script was authored.
// -------------------------------------------------------------------------

const A_REPLY: ActionDescriptor = {
  // packages/core/src/actions/to-tool.ts (REPLY core action)
  name: "REPLY",
  description: "Send a user-facing message reply.",
  parameters: [
    {
      name: "text",
      type: "string",
      description: "The user-visible message text.",
      required: true,
    },
  ],
};

const A_IGNORE: ActionDescriptor = {
  // packages/core/src/actions/to-tool.ts (IGNORE core action)
  name: "IGNORE",
  description: "Skip this turn — produce no reply and run no other actions.",
  parameters: [],
};

const A_SHELL: ActionDescriptor = {
  // plugins/plugin-coding-tools/src/actions/bash.ts
  name: "SHELL",
  description: "Run shell commands or manage shell command history.",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "Shell operation: run | clear_history | view_history.",
      enum: ["run", "clear_history", "view_history"],
    },
    {
      name: "command",
      type: "string",
      description:
        "Shell command to run for action=run; executed via /bin/bash -c <command>.",
    },
    {
      name: "description",
      type: "string",
      description: "Five to ten word humanly-readable summary of the command.",
    },
    {
      name: "timeout",
      type: "number",
      description:
        "Hard timeout in ms; clamped to [100, 600000]. Default 120000.",
    },
    {
      name: "cwd",
      type: "string",
      description:
        "Absolute working directory; must not resolve under a blocked path. Defaults to the session cwd.",
    },
    {
      name: "limit",
      type: "number",
      description:
        "For action=view_history: maximum number of recorded commands to return.",
    },
  ],
};

const A_FILE: ActionDescriptor = {
  // plugins/plugin-coding-tools/src/actions/file.ts
  name: "FILE",
  description:
    "File operations umbrella: action=read/write/edit/grep/glob/ls, optional target=device.",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "File operation to run.",
      enum: ["read", "write", "edit", "grep", "glob", "ls"],
      required: true,
    },
    {
      name: "target",
      type: "string",
      description:
        "Optional target filesystem. Use device for relative paths under the device filesystem bridge; omit for workspace files.",
      enum: ["workspace", "device"],
    },
    {
      name: "file_path",
      type: "string",
      description: "Absolute path for read/write/edit operations.",
    },
    {
      name: "path",
      type: "string",
      description:
        "Absolute file or directory path for grep/glob/ls. Defaults to the session cwd where supported.",
    },
    {
      name: "content",
      type: "string",
      description: "Full file contents for action=write.",
    },
    {
      name: "old_string",
      type: "string",
      description: "Exact substring to replace for action=edit.",
    },
    {
      name: "new_string",
      type: "string",
      description: "Replacement substring for action=edit.",
    },
    {
      name: "replace_all",
      type: "boolean",
      description:
        "For action=edit, replace every occurrence instead of requiring one match.",
    },
    {
      name: "pattern",
      type: "string",
      description: "Regex for action=grep or glob pattern for action=glob.",
    },
  ],
};

const A_TODO: ActionDescriptor = {
  // plugins/plugin-todos/src/actions/todo.ts
  name: "TODO",
  description:
    "todos: write|create|update|complete|cancel|delete|list|clear; user-scoped (entityId)",
  parameters: [
    {
      name: "action",
      type: "string",
      description:
        "Action: write, create, update, complete, cancel, delete, list, clear.",
      enum: [
        "write",
        "create",
        "update",
        "complete",
        "cancel",
        "delete",
        "list",
        "clear",
      ],
      required: true,
    },
    {
      name: "id",
      type: "string",
      description: "Todo id (update/complete/cancel/delete).",
    },
    {
      name: "content",
      type: "string",
      description: "Imperative form, e.g. 'Add tests' (create/update).",
    },
    {
      name: "activeForm",
      type: "string",
      description:
        "Present-continuous form, e.g. 'Adding tests' (create/update).",
    },
    {
      name: "status",
      type: "string",
      description: "pending | in_progress | completed | cancelled.",
      enum: ["pending", "in_progress", "completed", "cancelled"],
    },
    {
      name: "parentTodoId",
      type: "string",
      description: "Parent todo id for sub-tasks (create/update).",
    },
    {
      name: "includeCompleted",
      type: "boolean",
      description: "Include completed/cancelled todos in action=list output.",
    },
    {
      name: "limit",
      type: "number",
      description: "Max rows to return for action=list.",
    },
  ],
};

const A_PAYMENT: ActionDescriptor = {
  // plugins/plugin-mysticism/src/actions/payment-op.ts
  name: "PAYMENT",
  description: "Mysticism payment ops: check, request.",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "Operation: check or request.",
      enum: ["check", "request"],
      required: true,
    },
    {
      name: "amount",
      type: "string",
      description: "For request — payment amount as a string (e.g. '3.00').",
    },
    {
      name: "entityId",
      type: "string",
      description:
        "For check — optional entity id whose active reading payment should be checked. Defaults to the current sender.",
    },
    {
      name: "roomId",
      type: "string",
      description:
        "For check — optional room id whose active reading payment should be checked. Defaults to the current room.",
    },
  ],
};

const A_MUSIC: ActionDescriptor = {
  // plugins/plugin-music/src/actions/music.ts
  name: "MUSIC",
  description:
    "Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "Verb-shaped subaction.",
      enum: [
        "play",
        "pause",
        "resume",
        "skip",
        "stop",
        "queue_view",
        "queue_add",
        "queue_clear",
        "playlist_play",
        "playlist_save",
        "search",
        "play_query",
        "download",
        "play_audio",
        "set_routing",
        "set_zone",
        "generate",
        "extend",
        "custom_generate",
      ],
    },
    {
      name: "query",
      type: "string",
      description: "Search/play/queue query depending on subaction.",
    },
    {
      name: "url",
      type: "string",
      description: "Direct media URL when using play_audio or play.",
    },
    {
      name: "playlistName",
      type: "string",
      description: "Playlist name for playlist_play / playlist_save.",
    },
    {
      name: "song",
      type: "string",
      description: "Song query when adding to a playlist.",
    },
    {
      name: "limit",
      type: "number",
      description: "Search result limit (search / library helpers).",
    },
    {
      name: "confirmed",
      type: "boolean",
      description:
        "Must be true when the underlying operation requires confirmation.",
    },
  ],
};

const A_GITHUB: ActionDescriptor = {
  // plugins/plugin-github/src/actions/github.ts
  name: "GITHUB",
  description:
    "GitHub: pr_list|pr_review|issue_create|issue_assign|issue_close|issue_reopen|issue_comment|issue_label|notification_triage",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "GitHub operation to run.",
      enum: [
        "pr_list",
        "pr_review",
        "issue_create",
        "issue_assign",
        "issue_close",
        "issue_reopen",
        "issue_comment",
        "issue_label",
        "notification_triage",
      ],
      required: true,
    },
    {
      name: "repo",
      type: "string",
      description: "Repository in owner/name form.",
    },
    {
      name: "number",
      type: "number",
      description: "Pull request or issue number.",
    },
    {
      name: "state",
      type: "string",
      description: "PR state for pr_list: open, closed, or all.",
      enum: ["open", "closed", "all"],
    },
    {
      name: "review_action",
      type: "string",
      description:
        "For action=pr_review: approve, request-changes, or comment.",
      enum: ["approve", "request-changes", "comment"],
    },
    {
      name: "title",
      type: "string",
      description: "Issue title for action=issue_create.",
    },
    {
      name: "body",
      type: "string",
      description: "Issue body, issue comment body, or PR review body.",
    },
    {
      name: "as",
      type: "string",
      description: "Identity to use: agent or user.",
      enum: ["agent", "user"],
    },
    {
      name: "confirmed",
      type: "boolean",
      description: "Must be true for GitHub write operations.",
    },
  ],
};

const A_BROWSER: ActionDescriptor = {
  // plugins/plugin-browser/src/actions/browser.ts
  name: "BROWSER",
  description:
    "Browser tab/page control: open/navigate/click/type/screenshot/state; action autofill_login + domain autofill vault-gated credential into workspace tab.",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "Browser action to perform.",
      enum: [
        "back",
        "click",
        "close",
        "context",
        "forward",
        "get",
        "navigate",
        "open",
        "open_tab",
        "press",
        "reload",
        "screenshot",
        "state",
        "type",
        "wait",
        "close_tab",
        "switch_tab",
        "autofill_login",
      ],
    },
    {
      name: "url",
      type: "string",
      description: "URL for open or navigate.",
    },
    {
      name: "selector",
      type: "string",
      description: "Selector for click, type, or wait.",
    },
    {
      name: "text",
      type: "string",
      description: "Text for type.",
    },
    {
      name: "key",
      type: "string",
      description: "Keyboard key for press.",
    },
    {
      name: "domain",
      type: "string",
      description:
        "Required when action is autofill_login: registrable hostname (e.g. github.com).",
    },
    {
      name: "username",
      type: "string",
      description:
        "When using autofill-login: specific saved login; omit for most recently modified.",
    },
    {
      name: "submit",
      type: "boolean",
      description:
        "When using autofill-login: submit the form after filling (default false).",
    },
  ],
};

const A_FORM: ActionDescriptor = {
  // plugins/plugin-form/src/actions/form.ts
  name: "FORM",
  description: "Form session router (restore).",
  parameters: [
    {
      name: "action",
      type: "string",
      description: "Form verb: restore. Defaults to restore when omitted.",
      enum: ["restore"],
    },
    {
      name: "sessionId",
      type: "string",
      description: "Optional stashed form session id to restore.",
    },
  ],
};

const A_VISION: ActionDescriptor = {
  // plugins/plugin-vision/src/action.ts
  name: "VISION",
  description:
    "Vision: describe / capture / set_mode / name_entity / identify_person / track_entity.",
  parameters: [
    {
      name: "action",
      type: "string",
      description:
        "Operation to perform: describe, capture, set_mode, name_entity, identify_person, or track_entity.",
      enum: [
        "describe",
        "capture",
        "set_mode",
        "enable_camera",
        "disable_camera",
        "enable_screen",
        "disable_screen",
        "name_entity",
        "identify_person",
        "track_entity",
      ],
    },
    {
      name: "detailLevel",
      type: "string",
      description:
        "For action=describe: 'summary' to omit object/person breakdowns, 'detailed' for the full breakdown.",
      enum: ["summary", "detailed"],
    },
    {
      name: "mode",
      type: "string",
      description:
        "For action=set_mode: vision mode to set: off, camera, screen, or both.",
      enum: ["off", "camera", "screen", "both"],
    },
    {
      name: "name",
      type: "string",
      description:
        "For action=name_entity: the name to assign to the most relevant visible person or object.",
    },
    {
      name: "targetHint",
      type: "string",
      description:
        "For action=name_entity or action=identify_person: optional phrase describing which visible entity to focus on.",
    },
    {
      name: "includeUnknown",
      type: "boolean",
      description:
        "For action=identify_person: whether to mention unidentified people in the response.",
    },
  ],
};

const A_WALLET: ActionDescriptor = {
  // plugins/plugin-wallet/src/chains/wallet-action.ts
  name: "WALLET",
  description:
    "WALLET umbrella: action=transfer|swap|bridge|gov (chain ops) | token_info (market data) | search_address (Birdeye portfolio).",
  parameters: [
    {
      name: "action",
      type: "string",
      description:
        "Wallet operation to perform. Write ops use the chain handler registry; analytics ops use the token-info provider registry.",
      enum: [
        "transfer",
        "swap",
        "bridge",
        "gov",
        "token_info",
        "search_address",
      ],
      required: true,
    },
    {
      name: "target",
      type: "string",
      description:
        "Chain id/name for write ops (source chain for bridge); analytics provider for token_info.",
    },
    {
      name: "toChain",
      type: "string",
      description: "Destination chain for bridge.",
    },
    {
      name: "fromToken",
      type: "string",
      description: "Source token symbol, native token alias, or token address.",
    },
    {
      name: "toToken",
      type: "string",
      description:
        "Destination token symbol, native token alias, or token address.",
    },
    {
      name: "amount",
      type: "string",
      description:
        "Human-readable token amount. Required for transfer, swap, and bridge.",
    },
    {
      name: "recipient",
      type: "string",
      description: "Recipient address for transfer.",
    },
    {
      name: "slippageBps",
      type: "number",
      description: "Maximum swap slippage in basis points.",
    },
    {
      name: "mode",
      type: "string",
      description: "Prepare without submitting, or execute the operation.",
      enum: ["prepare", "execute"],
    },
    {
      name: "dryRun",
      type: "boolean",
      description: "Return metadata without signing or sending.",
    },
  ],
};

const A_MCP: ActionDescriptor = {
  // plugins/plugin-mcp/src/actions/mcp.ts
  name: "MCP",
  description: "MCP call_tool read_resource search_actions list_connections",
  parameters: [
    {
      name: "action",
      type: "string",
      description:
        "MCP operation: call_tool | read_resource | search_actions | list_connections",
      enum: [
        "call_tool",
        "read_resource",
        "search_actions",
        "list_connections",
      ],
    },
    {
      name: "serverName",
      type: "string",
      description: "Optional MCP server name that owns the tool or resource.",
    },
    {
      name: "toolName",
      type: "string",
      description: "For action=call_tool: optional exact MCP tool name to call.",
    },
    {
      name: "uri",
      type: "string",
      description: "For action=read_resource: exact MCP resource URI to read.",
    },
    {
      name: "query",
      type: "string",
      description:
        "Natural-language description of the tool call or resource to select; for action=search_actions, the keyword query.",
    },
    {
      name: "platform",
      type: "string",
      description:
        "For action=search_actions: filter results to a single connected platform.",
    },
    {
      name: "limit",
      type: "number",
      description: "For action=search_actions: maximum results to return.",
    },
    {
      name: "offset",
      type: "number",
      description:
        "For action=search_actions: skip first N results for pagination.",
    },
  ],
};

const A_CREATE_LINEAR_ISSUE: ActionDescriptor = {
  // plugins/plugin-linear/src/actions/createIssue.ts
  // The real action carries an object-typed `issueData` parameter that
  // PlannerParameterDescriptor cannot represent. We expose the canonical NAME
  // with no scalar params so the planner exercise is purely intent-routing
  // for "create a Linear issue" prompts.
  name: "CREATE_LINEAR_ISSUE",
  description: "create new issue Linear",
  parameters: [],
};

const ACTIONS_BY_NAME: Record<string, ActionDescriptor> = {
  REPLY: A_REPLY,
  IGNORE: A_IGNORE,
  SHELL: A_SHELL,
  FILE: A_FILE,
  TODO: A_TODO,
  PAYMENT: A_PAYMENT,
  MUSIC: A_MUSIC,
  GITHUB: A_GITHUB,
  BROWSER: A_BROWSER,
  FORM: A_FORM,
  VISION: A_VISION,
  WALLET: A_WALLET,
  MCP: A_MCP,
  CREATE_LINEAR_ISSUE: A_CREATE_LINEAR_ISSUE,
};

// -------------------------------------------------------------------------
// Hand-authored cases. Each `target` lists the focal action; `siblings` are
// distractor actions added to the registry to force the planner to
// discriminate. `expected_params` only lists keys we can verify from the
// prompt verbatim — extras are tolerated by the bench's label_match.
//
// `kind: "hit"` cases are clear-intent prompts where the focal action is the
// right pick. `kind: "near-miss"` cases share the focal action's domain but
// have a phrasing twist that requires reading parameters carefully (e.g.
// asking to *list* rather than *create*).
// -------------------------------------------------------------------------

interface CaseSeed {
  id: string;
  input: string;
  target: string;
  siblings: string[];
  expected_action_name: string;
  expected_params: Record<string, string | number | boolean>;
  notes?: string;
}

const CASE_SEEDS: CaseSeed[] = [
  // SHELL ----------------------------------------------------------------
  {
    id: "shell-run-ls",
    input: "run `ls -la /tmp` in the workspace shell",
    target: "SHELL",
    siblings: ["FILE", "REPLY"],
    expected_action_name: "SHELL",
    expected_params: { action: "run" },
    notes: "Direct shell command — SHELL action=run.",
  },
  {
    id: "shell-view-history",
    input: "show me the last few shell commands you ran in this conversation",
    target: "SHELL",
    siblings: ["FILE", "REPLY"],
    expected_action_name: "SHELL",
    expected_params: { action: "view_history" },
    notes: "Discriminates view_history from a generic FILE list.",
  },

  // FILE -----------------------------------------------------------------
  {
    id: "file-read-config",
    input: "read /etc/hosts and show the contents",
    target: "FILE",
    siblings: ["SHELL", "REPLY"],
    expected_action_name: "FILE",
    expected_params: { action: "read", file_path: "/etc/hosts" },
    notes: "Plain file read — FILE action=read with absolute path.",
  },
  {
    id: "file-grep-pattern",
    input: "search the repo for the string `actionToTool` under packages/core",
    target: "FILE",
    siblings: ["SHELL", "REPLY"],
    expected_action_name: "FILE",
    expected_params: { action: "grep" },
    notes: "Near-miss vs SHELL: code search routes through FILE action=grep.",
  },

  // TODO -----------------------------------------------------------------
  {
    id: "todo-create-task",
    input: "add a todo: write the release notes for 1.6",
    target: "TODO",
    siblings: ["REPLY", "FORM"],
    expected_action_name: "TODO",
    expected_params: { action: "create" },
    notes: "Single-item add — TODO action=create.",
  },
  {
    id: "todo-list-pending",
    input: "what's on my todo list right now?",
    target: "TODO",
    siblings: ["REPLY", "FORM"],
    expected_action_name: "TODO",
    expected_params: { action: "list" },
    notes: "Read intent — TODO action=list, not create/update.",
  },
  {
    id: "todo-complete-by-id",
    input: "mark todo 7f2c-9 as done",
    target: "TODO",
    siblings: ["REPLY", "TODO"],
    expected_action_name: "TODO",
    expected_params: { action: "complete", id: "7f2c-9" },
    notes: "Targeted complete — discriminates from delete/cancel.",
  },

  // PAYMENT --------------------------------------------------------------
  {
    id: "payment-request-amount",
    input: "ask the seeker for $3.00 to start a Celtic Cross reading",
    target: "PAYMENT",
    siblings: ["REPLY", "WALLET"],
    expected_action_name: "PAYMENT",
    expected_params: { action: "request", amount: "3.00" },
    notes: "Mysticism reading payment request with amount string.",
  },
  {
    id: "payment-check-status",
    input: "did the user's payment for the reading come through yet?",
    target: "PAYMENT",
    siblings: ["REPLY", "WALLET"],
    expected_action_name: "PAYMENT",
    expected_params: { action: "check" },
    notes:
      "Status check — must pick PAYMENT action=check, not WALLET search_address.",
  },

  // MUSIC ----------------------------------------------------------------
  {
    id: "music-play-query",
    input: "play some lo-fi beats",
    target: "MUSIC",
    siblings: ["REPLY", "VISION"],
    expected_action_name: "MUSIC",
    expected_params: { action: "play" },
    notes: "Generic playback intent — MUSIC action=play.",
  },
  {
    id: "music-pause",
    input: "pause the music",
    target: "MUSIC",
    siblings: ["REPLY", "VISION"],
    expected_action_name: "MUSIC",
    expected_params: { action: "pause" },
    notes: "Transport control — MUSIC action=pause.",
  },
  {
    id: "music-search-library",
    input: "search my library for songs by Phoebe Bridgers",
    target: "MUSIC",
    siblings: ["REPLY", "FILE"],
    expected_action_name: "MUSIC",
    expected_params: { action: "search" },
    notes: "Library search — discriminates from FILE grep/glob.",
  },

  // GITHUB ---------------------------------------------------------------
  {
    id: "github-pr-list-open",
    input: "list the open PRs in elizaos/eliza",
    target: "GITHUB",
    siblings: ["REPLY", "MCP"],
    expected_action_name: "GITHUB",
    expected_params: { action: "pr_list", repo: "elizaos/eliza", state: "open" },
    notes: "PR listing — GITHUB action=pr_list with repo + state.",
  },
  {
    id: "github-issue-create",
    input:
      "open a GitHub issue on elizaos/eliza titled 'crash on macOS arm64 launch'",
    target: "GITHUB",
    siblings: ["REPLY", "CREATE_LINEAR_ISSUE"],
    expected_action_name: "GITHUB",
    expected_params: { action: "issue_create", repo: "elizaos/eliza" },
    notes:
      "Discriminates GitHub issue_create from the Linear CREATE_LINEAR_ISSUE sibling.",
  },
  {
    id: "github-pr-review-approve",
    input: "approve PR #1234 on elizaos/eliza",
    target: "GITHUB",
    siblings: ["REPLY", "MCP"],
    expected_action_name: "GITHUB",
    expected_params: {
      action: "pr_review",
      repo: "elizaos/eliza",
      number: 1234,
      review_action: "approve",
    },
    notes: "PR review with numeric number + enum review_action.",
  },

  // BROWSER --------------------------------------------------------------
  {
    id: "browser-navigate",
    input: "navigate the browser to https://anthropic.com/news",
    target: "BROWSER",
    siblings: ["REPLY", "MCP"],
    expected_action_name: "BROWSER",
    expected_params: {
      action: "navigate",
      url: "https://anthropic.com/news",
    },
    notes: "Navigation with URL extraction.",
  },
  {
    id: "browser-screenshot",
    input: "take a screenshot of the current browser tab",
    target: "BROWSER",
    siblings: ["REPLY", "VISION"],
    expected_action_name: "BROWSER",
    expected_params: { action: "screenshot" },
    notes: "Discriminates BROWSER screenshot from VISION capture.",
  },
  {
    id: "browser-autofill",
    input: "log me into github.com using the saved credentials",
    target: "BROWSER",
    siblings: ["REPLY", "MCP"],
    expected_action_name: "BROWSER",
    expected_params: { action: "autofill_login", domain: "github.com" },
    notes: "Vault-gated autofill — BROWSER action=autofill_login + domain.",
  },

  // FORM -----------------------------------------------------------------
  {
    id: "form-restore-stashed",
    input: "resume the form I had open before",
    target: "FORM",
    siblings: ["REPLY", "TODO"],
    expected_action_name: "FORM",
    expected_params: { action: "restore" },
    notes: "Stashed-form rehydration intent — FORM action=restore.",
  },

  // VISION ---------------------------------------------------------------
  {
    id: "vision-describe-scene",
    input: "describe what the camera sees right now",
    target: "VISION",
    siblings: ["REPLY", "BROWSER"],
    expected_action_name: "VISION",
    expected_params: { action: "describe" },
    notes: "Camera scene description — VISION action=describe.",
  },
  {
    id: "vision-set-mode-screen",
    input: "switch vision to screen-only mode",
    target: "VISION",
    siblings: ["REPLY", "BROWSER"],
    expected_action_name: "VISION",
    expected_params: { action: "set_mode", mode: "screen" },
    notes: "Mode switch with enum mode value.",
  },
  {
    id: "vision-name-entity",
    input: "remember the person on the left as Jamie",
    target: "VISION",
    siblings: ["REPLY", "BROWSER"],
    expected_action_name: "VISION",
    expected_params: { action: "name_entity", name: "Jamie" },
    notes: "Entity-naming intent with extracted name.",
  },

  // WALLET ---------------------------------------------------------------
  {
    id: "wallet-transfer-eth",
    input:
      "send 0.1 ETH on base to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    target: "WALLET",
    siblings: ["REPLY", "PAYMENT"],
    expected_action_name: "WALLET",
    expected_params: {
      action: "transfer",
      target: "base",
      fromToken: "ETH",
      amount: "0.1",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    },
    notes: "Concrete on-chain transfer with chain + token + amount + recipient.",
  },
  {
    id: "wallet-swap-prepare",
    input: "prepare a swap of 25 USDC for SOL on solana",
    target: "WALLET",
    siblings: ["REPLY", "PAYMENT"],
    expected_action_name: "WALLET",
    expected_params: {
      action: "swap",
      target: "solana",
      fromToken: "USDC",
      toToken: "SOL",
      amount: "25",
      mode: "prepare",
    },
    notes: "Swap with chain + dual-token + enum mode.",
  },
  {
    id: "wallet-token-info-lookup",
    input: "what's the current price of SOL on dexscreener?",
    target: "WALLET",
    siblings: ["REPLY", "PAYMENT"],
    expected_action_name: "WALLET",
    expected_params: { action: "token_info", target: "dexscreener" },
    notes: "Analytics path — WALLET action=token_info, not transfer/swap.",
  },

  // MCP ------------------------------------------------------------------
  {
    id: "mcp-call-tool",
    input: "call the linear MCP tool to fetch my recent issues",
    target: "MCP",
    siblings: ["REPLY", "GITHUB"],
    expected_action_name: "MCP",
    expected_params: { action: "call_tool" },
    notes: "MCP tool invocation — MCP action=call_tool.",
  },
  {
    id: "mcp-search-actions",
    input: "search MCP for actions that mention 'calendar'",
    target: "MCP",
    siblings: ["REPLY", "GITHUB"],
    expected_action_name: "MCP",
    expected_params: { action: "search_actions", query: "calendar" },
    notes: "Search routing — MCP action=search_actions with query.",
  },

  // CREATE_LINEAR_ISSUE --------------------------------------------------
  {
    id: "linear-create-issue",
    input:
      "file a Linear ticket: 'Login button broken on mobile' — assign to the mobile team",
    target: "CREATE_LINEAR_ISSUE",
    siblings: ["GITHUB", "REPLY"],
    expected_action_name: "CREATE_LINEAR_ISSUE",
    expected_params: {},
    notes:
      "Linear-specific issue creation — discriminates from GITHUB issue_create.",
  },
  {
    id: "linear-create-bug-report",
    input: "create a Linear bug report for the API 500 on user-profile updates",
    target: "CREATE_LINEAR_ISSUE",
    siblings: ["GITHUB", "REPLY"],
    expected_action_name: "CREATE_LINEAR_ISSUE",
    expected_params: {},
    notes: "Bug-report intent → CREATE_LINEAR_ISSUE.",
  },
];

// -------------------------------------------------------------------------
// Build + emit
// -------------------------------------------------------------------------

function buildCase(seed: CaseSeed): FixtureCase {
  // Build the available-actions registry: target first, then siblings in
  // their declared order, deduped by name. Each case carries 2-3 actions
  // total — enough for discrimination, not so many we blow the prompt.
  const seen = new Set<string>();
  const available: ActionDescriptor[] = [];
  for (const name of [seed.target, ...seed.siblings]) {
    if (seen.has(name)) continue;
    const desc = ACTIONS_BY_NAME[name];
    if (!desc) {
      throw new Error(
        `Unknown action '${name}' referenced in case '${seed.id}'.`,
      );
    }
    seen.add(name);
    available.push(desc);
  }
  const fixture: FixtureCase = {
    id: seed.id,
    input: seed.input,
    availableActions: available,
    expected_action_name: seed.expected_action_name,
    expected_params: seed.expected_params,
  };
  if (seed.notes) fixture.notes = seed.notes;
  return fixture;
}

function main(): void {
  // Validate every action name referenced is known.
  const referenced = new Set<string>();
  for (const seed of CASE_SEEDS) {
    referenced.add(seed.target);
    for (const s of seed.siblings) referenced.add(s);
    referenced.add(seed.expected_action_name);
  }
  for (const name of referenced) {
    if (!ACTIONS_BY_NAME[name]) {
      throw new Error(`Case references unknown action '${name}'.`);
    }
  }

  // Stable ordering: group by target action (sorted by name), then by case id
  // within each group.
  const sorted = [...CASE_SEEDS].sort((a, b) => {
    const t = a.target.localeCompare(b.target);
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });

  const cases = sorted.map(buildCase);

  const coverage = Array.from(new Set(sorted.map((s) => s.target))).sort();

  const fixture = {
    note:
      "Generated by scripts/eliza1/generate-canonical-planner-fixtures.ts — do not edit by hand. Each case ships a small action registry whose entries are real canonical action names from runtime plugins (SHELL, FILE, TODO, etc.), not the synthetic SEND_EMAIL/CREATE_REMINDER probes used by planner.json. expected_action_name + expected_params are best-effort labels used for label_match scoring; treat label_match as a comparison signal between modes, not an absolute correctness rate.",
    origin: "canonical",
    derivedFrom:
      "scripts/eliza1/generate-canonical-planner-fixtures.ts (canonical action descriptors lifted from plugin source files)",
    actionCoverage: coverage,
    cases,
  };

  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = path.resolve(HERE, "..", "..");
  const outPath = path.join(
    repoRoot,
    "packages/benchmarks/eliza-1/src/fixtures/planner.canonical.json",
  );
  mkdirSync(path.dirname(outPath), { recursive: true });
  // Two-space indent + trailing newline; identical to existing fixture files.
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(outPath, serialized, "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outPath,
        caseCount: cases.length,
        actionCount: coverage.length,
        actions: coverage,
      },
      null,
      2,
    )}\n`,
  );
}

main();
