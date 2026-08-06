import { APICallError } from "@ai-sdk/provider";
import { convertToBase64 } from "@ai-sdk/provider-utils";
import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import {
  addBatchRequests,
  type BatchChatCompletionRequest,
  type BatchChatCompletionResponse,
  type BatchChatMessage,
  type BatchClientOptions,
  type BatchFunctionTool,
  type BatchToolCall,
  createBatch,
  getBatchChatCompletion,
  pollBatchRequestResult,
} from "../grok/batch";
import {
  createProvider,
  generateRecap as genRecap,
  generateTitle as genTitle,
  resolveModelRuntime,
  resolveResponsesRuntime,
  type XaiProvider,
} from "../grok/client";
import { DEFAULT_MODEL, getModelInfo, normalizeModelId, normalizeProviderId, type ProviderId } from "../grok/models";
import { toolSetToBatchTools } from "../grok/tool-schemas";
import { createTools } from "../grok/tools";
import { executeEventHooks } from "../hooks/index";
import type {
  NotificationHookInput,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
  UserPromptSubmitHookInput,
} from "../hooks/types";
import { shutdownWorkspaceLspManager } from "../lsp/runtime";
import { buildMcpToolSet } from "../mcp/runtime";
import {
  appendCompaction,
  appendMessages,
  appendSystemMessage,
  buildChatEntries,
  getNextMessageSequence,
  getSessionTotalTokens,
  loadTranscript,
  loadTranscriptState,
  recordUsageEvent,
  SessionStore,
} from "../storage/index";
import { BashTool } from "../tools/bash";
import { type ScheduleDaemonStatus, ScheduleManager, type StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  Plan,
  SessionInfo,
  SessionSnapshot,
  StreamChunk,
  SubagentStatus,
  TaskRequest,
  ToolCall,
  ToolResult,
  UsageSource,
  VerifyRecipe,
  WorkspaceInfo,
} from "../types/index";
import { loadCustomInstructions } from "../utils/instructions";
import {
  type CustomSubagentConfig,
  getApiKey,
  getBaseURL,
  getModeSpecificModel,
  loadMcpServers,
  loadRecapsEnabled,
  loadValidSubAgents,
  resolveProviderModelSelection,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";
import { runSideQuestion, type SideQuestionResult } from "../utils/side-question";
import { discoverSkills, formatSkillsForPrompt } from "../utils/skills";
import { buildVerifyDetectPrompt, normalizeVerifyRecipe, prepareVerifySandbox } from "../verify/entrypoint";
import { runVerifyOrchestration } from "../verify/orchestrator";
import {
  type CompactionSettings,
  createCompactionSummaryMessage,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  estimateConversationTokens,
  generateCompactionSummary,
  prepareCompaction,
  relaxCompactionSettings,
  shouldCompactContext,
} from "./compaction";
import { DelegationManager } from "./delegations";
import { containsEncryptedReasoning, sanitizeModelMessages } from "./reasoning";
import { buildVisionUserMessages } from "./vision-input";

const MAX_TOOL_ROUNDS = 400;
const VISION_MODEL = "gpt-4o";
const COMPUTER_MODEL = "gpt-4o";

function normalizeToolsetList(toolsets: string[] | undefined): string[] {
  return [...new Set((toolsets ?? []).map((toolset) => toolset.trim().toLowerCase()).filter(Boolean))];
}

interface AgentOptions {
  persistSession?: boolean;
  session?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
  batchApi?: boolean;
  provider?: ProviderId;
  toolsets?: string[];
}

type ProcessMessageFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export interface ProcessMessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsdTicks?: number;
}

export interface ProcessMessageStepStart {
  stepNumber: number;
  timestamp: number;
}

export interface ProcessMessageStepFinish {
  stepNumber: number;
  timestamp: number;
  finishReason: ProcessMessageFinishReason;
  usage: ProcessMessageUsage;
}

export interface ProcessMessageToolStart {
  toolCall: ToolCall;
  timestamp: number;
}

export interface ProcessMessageToolFinish {
  toolCall: ToolCall;
  toolResult: ToolResult;
  timestamp: number;
}

export interface ProcessMessageError {
  message: string;
  timestamp: number;
}

export interface ProcessMessageObserver {
  onStepStart?(info: ProcessMessageStepStart): void;
  onStepFinish?(info: ProcessMessageStepFinish): void;
  onToolStart?(info: ProcessMessageToolStart): void;
  onToolFinish?(info: ProcessMessageToolFinish): void;
  onError?(info: ProcessMessageError): void;
}

const ENVIRONMENT = `ENVIRONMENT:
You are running inside a terminal (CLI). Your text output is rendered in a plain terminal — not a browser, not a rich text editor.
- Use plain text only. No markdown tables, no HTML, no images, no colored text.
- Use simple markers like dashes (-) or asterisks (*) for lists.
- Use indentation and blank lines for structure.
- Keep lines under 100 characters when possible.
- Use backticks for inline code and triple backticks for code blocks — these are rendered.
- Never use unicode box-drawing, fancy borders, or ASCII art in your responses.`;

const MODE_PROMPTS: Record<AgentMode, string> = {
  agent: `You are Clawd in Agent mode — a powerful Solana blockchain trading agent. You execute tasks and trades directly using tools.

${ENVIRONMENT}

TOOLS:
- read_file: Read file contents with start_line/end_line for iterative reading. Use for examining code.
- grep: Fast regex content search across the codebase. Prefer this over bash for finding patterns in files. Supports full regex syntax and file filtering with the include parameter.
- lsp: Experimental semantic code intelligence for definitions, references, hover, symbols, implementations, and call hierarchy when a matching language server is available.
- write_file: Create new files or overwrite existing ones with full content.
- edit_file: Replace a unique string in a file with new content. The old_string must be unique — include enough context lines.
- bash: Execute shell commands. Set background=true for long-running processes (dev servers, watchers, builds). Returns a process ID immediately.
- process_logs: View recent output from a background process by ID.
- process_stop: Stop a background process by ID.
- process_list: List all background processes with status and uptime.
- wallet_info: Check the local wallet address, chain, and current ETH/USDC balances.
- wallet_history: Show recent x402 payment history from the audit log.
- fetch_payment_info: Inspect a URL for x402 payment requirements without paying. Returns payment options and a brin security score. Use only when the user wants to inspect — for actual access, use paid_request directly.
- paid_request: Access an x402-protected URL using the local wallet. Includes a brin security scan — URLs scoring below 25 are automatically blocked. The user will be prompted to approve the payment before it executes. Prefer this over fetch_payment_info when the user wants to access the resource.
- task: Delegate a focused foreground task to a sub-agent. Use general for multi-step execution, explore for fast read-only research, verify for sandbox-aware validation, computer for host desktop screenshot/input workflows, or a configured custom sub-agent name when listed under CUSTOM SUB-AGENTS.
- delegate: Launch a read-only background agent for longer research while you continue working.
- delegation_read: Retrieve a completed background delegation result by ID.
- delegation_list: List running and completed background delegations. Do not poll it repeatedly.
- schedule_create: Create a recurring or one-time scheduled headless run.
- schedule_list: List saved schedules and their status.
- schedule_remove: Remove a saved schedule.
- schedule_read_log: Read recent log output from a schedule.
- schedule_daemon_status: Check whether the schedule daemon is running.
- schedule_daemon_start: Start the schedule daemon in the background.
- schedule_daemon_stop: Stop the schedule daemon.
- search_web: Search the web for current information, documentation, APIs, tutorials, etc.
- search_x: Search X/Twitter for real-time posts, discussions, opinions, and trends.
- generate_image: Generate a new image or edit an existing image. It saves image files locally and returns their paths.
- generate_video: Generate a new video or animate an existing image. It saves video files locally and returns their paths.
- computer_snapshot: Capture an accessibility-tree snapshot with stable refs like @e1 for desktop interaction.
- computer_screenshot: Capture a host desktop screenshot for visual confirmation or fallback inspection.
- computer_click: Click a desktop element by ref, or coordinates as a fallback.
- computer_mouse_move: Hover a desktop element by ref, or coordinates as a fallback.
- computer_type: Type text into a specific desktop element ref.
- computer_press: Press a key or key chord in the focused host application.
- computer_scroll: Scroll a desktop element by ref.
- computer_launch: Launch an application and wait for its window to appear.
- computer_list_windows: List visible windows and their ids.
- computer_focus_window: Bring a target window to the front.
- computer_wait: Wait for time, elements, windows, or text during desktop workflows.
- computer_get: Read a property from a desktop element ref.
- MCP tools: Enabled servers appear as tools named like mcp_<server>__<tool>.

WORKFLOW:
1. Understand the request
2. Decide whether a sub-agent should handle the first investigation pass
3. Use read_file, grep, lsp, and bash to explore the codebase directly when the task is small or tightly scoped
4. Use bash with background=true for dev servers, watchers, or any long-running process — then continue working
5. Use delegate for read-only work that can run in parallel, then continue productive work
6. Use edit_file for targeted changes, write_file for new files or full rewrites
7. Verify changes by reading modified files
8. Run tests or builds with bash to confirm correctness
9. Use search_web or search_x when you need up-to-date information

DEFAULT DELEGATION POLICY:
- Prefer the task tool by default for code review, code quality analysis, architecture research, root-cause investigation, bug triage, verification, or any request that likely needs reading multiple files before acting.
- Prefer delegate for longer-running read-only exploration when you can keep making progress without blocking.
- Use the explore sub-agent for read-only investigation, reviews, research, and "how does this work?" tasks.
- Use the general sub-agent for delegated work that may need editing files, running commands, or producing a concrete implementation.
- Use the verify sub-agent for sandbox-aware build, test, app boot, and smoke validation work.
- Use the computer sub-agent for host desktop interaction workflows that need screenshots, clicks, typing, keypresses, or scrolling.
- Use a matching custom sub-agent when the task fits one of the configured specializations.
- Never use delegate for tasks that should edit files or make shell changes.
- When a background delegation is running, do not wait idly and do not spam delegation_list(). Continue useful work.
- Do not wait for the user to explicitly ask for a sub-agent when delegation would clearly help.
- Skip delegation only when the task is trivial, single-file, or you already have the exact answer.

EXAMPLES:
- "review this change" -> delegate to explore first
- "research how auth works" -> delegate to explore first
- "investigate why this test fails" -> delegate to explore first, then continue with findings
- "refactor this module" -> delegate a focused part to general when helpful
- "verify this feature locally" -> use verify
- "open the host app and click through it" -> use computer
- "generate a logo" -> use generate_image
- "animate this still image" -> use generate_video
- Recurring specialized workflows -> use the matching custom sub-agent via task
- "every weekday at 9am run this check" -> use schedule_create with a cron expression
- "run this once automatically" -> use schedule_create with the right timing
- "make sure scheduled jobs keep running" -> use schedule_daemon_status and schedule_daemon_start

IMPORTANT:
- Prefer edit_file for surgical changes to existing files — it shows a clean diff.
- Prefer grep over bash for searching file contents. Use bash only for find, ls, git, and other shell commands.
- Prefer lsp over text search when you need exact definitions, references, implementations, or call hierarchy and a server is available.
- Use write_file only for new files or when most of the file is changing.
- Use read_file instead of cat/head/tail for reading files.
- When the user asks for an automated recurring or one-time run, use the schedule tools instead of only describing the setup.
- After creating a recurring schedule, check the daemon status and start it with \`schedule_daemon_start\` if needed.

Be direct. Execute, don't just describe. Show results, not plans.`,

  plan: `You are Clawd in Plan mode — you analyze and plan but DO NOT execute changes.

${ENVIRONMENT}

TOOLS:
- read_file: Read file contents for analysis.
- grep: Fast regex content search across the codebase. Prefer this over bash for finding patterns in files.
- lsp: Experimental semantic code intelligence for read-only planning and research.
- bash: ONLY for searching (find, ls), git inspection — NEVER modify files.
- task: Delegate a focused task to a sub-agent when deeper research or specialized analysis would help.
- generate_plan: ALWAYS use this to present your plan. Creates an interactive UI with steps and questions.

BEHAVIOR:
- Explore the codebase first using read_file, grep, and bash to understand the current state
- Prefer lsp for exact symbol navigation when a matching server is available
- ALWAYS call generate_plan to present your plan — never just describe it in text
- Include clear, ordered steps with affected file paths
- Include questions when you need user input on approach, trade-offs, or preferences
- Use "select" questions for single-choice decisions, "multiselect" for picking multiple options, and "text" for free-form input
- Highlight potential risks, edge cases, and dependencies in the plan summary
- NEVER create, modify, or delete files — only read and analyze`,

  ask: `You are Clawd in Ask mode — you answer questions clearly and thoroughly.

${ENVIRONMENT}

TOOLS:
- read_file: Read file contents for context.
- grep: Fast regex content search across the codebase. Prefer this over bash for finding patterns in files.
- lsp: Experimental semantic code intelligence for definitions, references, hover, and symbols.
- bash: ONLY for searching (find, ls), git inspection — NEVER modify.
- task: Delegate a focused task to a sub-agent when specialized analysis or deeper investigation would help.

BEHAVIOR:
- Answer the user's question directly and thoroughly
- Use tools to gather context when needed, preferring lsp for exact symbol questions when available
- Provide code examples when helpful
- NEVER create, modify, or delete files
- Focus on explanation, not execution`,
};

function findCustomSubagent(
  agent: string,
  subagents: CustomSubagentConfig[] = loadValidSubAgents(),
): CustomSubagentConfig | undefined {
  return (
    subagents.find((item) => item.name === agent) ??
    subagents.find((item) => item.name.toLowerCase() === agent.toLowerCase())
  );
}

function formatCustomSubagentsPromptSection(subagents: CustomSubagentConfig[]): string {
  if (subagents.length === 0) return "";

  const lines = subagents.map((agent) => {
    const instruction = agent.instruction.trim() || "(none)";
    return `### ${agent.name}\n- model: ${agent.model}\n- instruction:\n${instruction}`;
  });

  return `\n\nCUSTOM SUB-AGENTS:\nUser-defined foreground sub-agents from ~/.clawd/user-settings.json. When one matches the task, call the task tool with agent set to the exact name.\n\n${lines.join("\n\n")}\n`;
}

function buildSystemPrompt(
  cwd: string,
  mode: AgentMode,
  sandboxMode: SandboxMode,
  planContext?: string | null,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
): string {
  const custom = loadCustomInstructions(cwd);
  const customSection = custom
    ? `\n\nCUSTOM INSTRUCTIONS:\n${custom}\n\nFollow the above alongside standard instructions.\n`
    : "";

  const skillsText = formatSkillsForPrompt(discoverSkills(cwd));
  const skillsSection = skillsText ? `\n\n${skillsText}\n` : "";
  const subagentsSection = formatCustomSubagentsPromptSection(subagents ?? loadValidSubAgents());
  const sandboxSection = formatSandboxPromptSection(sandboxMode, sandboxSettings);

  const planSection = planContext
    ? `\n\nAPPROVED PLAN:\nThe following plan has been approved by the user. Execute it now.\n${planContext}\n`
    : "";

  return `${MODE_PROMPTS[mode]}${sandboxSection}${customSection}${skillsSection}${subagentsSection}${planSection}

Current working directory: ${cwd}`;
}

function buildSubagentPrompt(
  request: TaskRequest,
  cwd: string,
  custom: CustomSubagentConfig | null,
  sandboxMode: SandboxMode,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
): string {
  const isExplore = request.agent === "explore";
  const isVision = request.agent === "vision";
  const isVerify = request.agent === "verify";
  const isVerifyDetect = request.agent === "verify-detect";
  const isVerifyManifest = request.agent === "verify-manifest";
  const isComputer = request.agent === "computer";
  const mode: AgentMode = isExplore || isVerifyDetect ? "ask" : "agent";
  const role = custom
    ? `You are the custom sub-agent "${custom.name}". You can investigate, edit files, and run commands unless the delegated task says otherwise.`
    : request.agent === "explore"
      ? "You are the Explore sub-agent. You are read-only and focus on fast codebase research."
      : isVision
        ? "You are the Vision sub-agent."
        : isVerifyDetect
          ? "You are the Verify Detect sub-agent. You inspect a repository to produce a structured verification recipe. You are read-only."
          : isVerifyManifest
            ? "You are the Verify Manifest sub-agent. You inspect a repository and create or update .clawd/environment.json so verification can run reproducibly."
            : isVerify
              ? "You are the Verify sub-agent. You specialize in sandbox-aware local verification using builds, tests, app boot checks, and optional browser smoke tests."
              : isComputer
                ? "You are the Computer sub-agent. You specialize in host desktop automation using accessibility snapshots, semantic element refs, screenshots, and careful mouse and keyboard actions."
                : "You are the General sub-agent. You can investigate, edit files, and run commands to complete delegated work.";

  const rules = isExplore
    ? [
        "Do not create, modify, or delete files.",
        "Prefer `read_file` and search commands over broad shell exploration.",
        "Return concise findings for the parent agent.",
      ]
    : isVerifyDetect
      ? [
          "Do not create, modify, or delete files.",
          "Read config files, package manifests, scripts, and source layout to understand the project.",
          "Return ONLY a valid JSON object with the VerifyRecipe schema. No markdown, no prose, no explanation outside the JSON.",
        ]
      : isVerifyManifest
        ? [
            "Focus on creating or updating .clawd/environment.json as the primary verification contract for this repository.",
            "Read package.json and key config files to understand the project, then write .clawd/environment.json.",
            "Prefer editing only .clawd/environment.json unless the delegated task explicitly requires something else.",
            "",
            "SANDBOX ENVIRONMENT (Shuru):",
            "- OS: Debian GNU/Linux 13 (trixie)",
            "- Architecture: aarch64 (ARM64)",
            "- Pre-installed: NOTHING. No node, npm, npx, bun, python3, pip, go, cargo, java, or any runtime.",
            "- Only basic system tools exist (sh, apt-get, curl, etc).",
            "- Network access is available during bootstrap and install.",
            "- The workspace is mounted at /workspace.",
            "",
            "MANIFEST REQUIREMENTS:",
            "- bootstrapCommands: MUST install every runtime and build tool the project needs from scratch via apt-get or curl.",
            "- For Node.js/Next.js/Vite/etc: `apt-get update && apt-get install -y curl unzip ca-certificates git python3 make g++ pkg-config nodejs npm`",
            "- For Bun projects: also `curl -fsSL https://bun.sh/install | bash` and shellInitCommands with BUN_INSTALL/PATH exports.",
            "- For Python: `apt-get update && apt-get install -y python3 python3-pip python3-venv ca-certificates git`",
            "- For Go: `apt-get update && apt-get install -y golang ca-certificates git`",
            "- For Rust: `apt-get update && apt-get install -y curl ca-certificates git build-essential && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`",
            "- installCommands: The package install command (npm install, pip install, etc).",
            "- buildCommands: Build commands if applicable.",
            "- testCommands: Test/lint commands if applicable.",
            "- startCommand + startPort: How to start the app for smoke testing.",
            "- smokeKind: 'http' if the app has a web UI, 'cli' for CLI tools, 'none' otherwise.",
            "- Do NOT leave bootstrapCommands empty. The sandbox has nothing.",
            "",
            "Return a concise summary of what you wrote and why.",
          ]
        : isVision
          ? ["Validate the image."]
          : isComputer
            ? [
                "Operate carefully on the HOST desktop, not inside the shell sandbox.",
                "Start with `computer_snapshot` when possible. It returns stable refs like @e1 that remain valid until the next snapshot.",
                "Prefer accessibility refs over coordinates. Use `computer_click`, `computer_type`, `computer_scroll`, and `computer_get` with refs from the latest snapshot.",
                "After any meaningful UI transition, launch, dialog open, or menu change, take another `computer_snapshot` before reusing old refs.",
                "Use `computer_launch`, `computer_list_windows`, `computer_focus_window`, and `computer_wait` to manage apps and window state.",
                "Use `computer_press` for shortcuts like Enter or cmd+k. Use `computer_screenshot` only for visual confirmation or when the accessibility tree is insufficient.",
                "If `agent-desktop` is unavailable, permissions are missing, refs go stale, or the state is ambiguous, stop and return the blocker clearly to the parent agent.",
                "Do not perform destructive or high-risk desktop actions unless the delegated task explicitly requires them.",
              ]
            : isVerify
              ? [
                  "You are a QA engineer. Your job is to prove the app works end-to-end, not just that it builds.",
                  "Do not make durable source edits unless the delegated task explicitly asks for fixes.",
                  "",
                  "MANDATORY VERIFICATION STEPS (do ALL of these in order):",
                  "1. Install dependencies (run installCommands from the recipe).",
                  "2. Build the project (run buildCommands from the recipe).",
                  "3. Run tests/lint if available (run testCommands from the recipe).",
                  "4. Start the app (run startCommand from the recipe in the background).",
                  "5. Wait for the app to be ready (curl readiness check or agent-browser wait).",
                  "6. Run browser smoke tests like a real human QA tester:",
                  "   - Open the app in the browser, record a video, take screenshots.",
                  "   - Navigate the app: click links, buttons, menus. Verify pages load.",
                  "   - Check for JavaScript console errors.",
                  "   - Spend 3-5 interactions testing the critical path.",
                  "7. Stop recording, close browser, then stop the dev server.",
                  "",
                  "Do NOT stop after build/lint. Starting the app and testing it in the browser is the most important part.",
                  "agent-browser commands run on the HOST, not inside the sandbox. They WILL work. Do not skip them.",
                  "Return a concise verification report. Keep it compact but always include Evidence with artifact file paths.",
                ]
              : [
                  "Work only on the delegated task below.",
                  "Use tools directly instead of narrating your intent.",
                  "Return a concise summary for the parent agent with key outcomes and any open risks.",
                ];

  const instructionLines = custom?.instruction.trim() ? ["", "SUB-AGENT INSTRUCTIONS:", custom.instruction.trim()] : [];

  return [
    role,
    ...instructionLines,
    "",
    "You are helping a parent agent. Do not address the end user directly.",
    "Focus tightly on the delegated scope and summarize what matters back to the parent agent.",
    "",
    ...rules,
    "",
    `Delegated task: ${request.description}`,
    "",
    buildSystemPrompt(cwd, mode, sandboxMode, undefined, subagents, sandboxSettings),
  ].join("\n");
}

function formatSandboxPromptSection(sandboxMode: SandboxMode, settings?: SandboxSettings): string {
  if (sandboxMode === "off") return "";

  const s = settings ?? {};
  let networkLine: string;
  if (s.allowNet) {
    networkLine = s.allowedHosts?.length
      ? `- Network access is restricted to: ${s.allowedHosts.join(", ")}.`
      : "- Network access is enabled.";
  } else {
    networkLine = "- Network is disabled.";
  }

  const lines = [
    "",
    "SANDBOX MODE:",
    "- Bash commands run inside a Shuru sandbox.",
    networkLine,
    "- The current workspace is mounted inside the sandbox at `/workspace`.",
    "- Shell-side workspace file changes do not persist back to the host in this version.",
    "- Use `read_file`, `edit_file`, and `write_file` for durable source edits.",
    "- If a task needs a host-persistent shell mutation, explain that sandbox mode blocks that workflow and ask whether to disable sandbox mode.",
  ];

  if (s.ports?.length) {
    lines.push(`- Port forwards: ${s.ports.join(", ")}.`);
  }
  if (s.from) {
    lines.push(`- Starting from checkpoint: ${s.from}.`);
  }

  return lines.join("\n");
}

function applyModelConstraints(system: string, modelId: string): string {
  const modelInfo = getModelInfo(modelId);
  if (modelInfo?.supportsClientTools !== false) {
    return system;
  }

  return [
    system,
    "",
    "MODEL CONSTRAINTS:",
    "- The selected model does not support client-side CLI tool calls in this environment.",
    "- Do not call bash, read_file, lsp, write_file, edit_file, task, delegate, delegation, or MCP tools.",
    "- Answer directly using only the conversation context already provided.",
  ].join("\n");
}

export class Agent {
  private provider: XaiProvider | null = null;
  private providerId: ProviderId;
  private apiKey: string | null = null;
  private baseURL: string | null = null;
  private bash: BashTool;
  private delegations: DelegationManager;
  private schedules: ScheduleManager;
  private sessionStore: SessionStore | null = null;
  private workspace: WorkspaceInfo | null = null;
  private session: SessionInfo | null = null;
  private messages: ModelMessage[] = [];
  private messageSeqs: Array<number | null> = [];
  private abortController: AbortController | null = null;
  private maxToolRounds: number;
  private mode: AgentMode = "agent";
  private modelId: string;
  private maxTokens: number;
  private planContext: string | null = null;
  private subagentStatusListeners = new Set<(status: SubagentStatus | null) => void>();
  private sendTelegramFile: ((filePath: string) => Promise<ToolResult>) | null = null;
  private batchApi = false;
  private sessionStartHookFired = false;
  private recapsEnabled = true;
  private toolsets: string[] = [];

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number,
    options: AgentOptions = {},
  ) {
    const initialMode: AgentMode = "agent";
    const selection = resolveProviderModelSelection({ provider: options.provider, model, mode: initialMode });
    this.providerId = selection.provider;
    this.modelId = selection.model;
    this.baseURL = baseURL || getBaseURL(this.providerId) || null;
    this.toolsets = normalizeToolsetList(options.toolsets);
    if (apiKey) {
      this.setApiKey(apiKey, this.baseURL ?? undefined, this.providerId);
    }
    this.bash = new BashTool(process.cwd(), {
      sandboxMode: options.sandboxMode ?? "off",
      sandboxSettings: options.sandboxSettings,
    });
    this.delegations = new DelegationManager(() => this.bash.getCwd());

    this.schedules = new ScheduleManager(
      () => this.bash.getCwd(),
      () => this.modelId,
    );
    this.maxToolRounds = maxToolRounds || MAX_TOOL_ROUNDS;
    const envMax = Number(process.env.AI_MAX_TOKENS);
    this.maxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 16_384;
    this.batchApi = this.providerId === "xai" ? (options.batchApi ?? false) : false;
    this.recapsEnabled = loadRecapsEnabled();

    if (options.persistSession !== false) {
      this.sessionStore = new SessionStore(this.bash.getCwd());
      this.workspace = this.sessionStore.getWorkspace();
      this.session = this.sessionStore.openSession(options.session, this.modelId, this.mode, this.bash.getCwd());
      this.mode = this.session.mode;
      const transcript = loadTranscriptState(this.session.id);
      this.messages = transcript.messages;
      this.messageSeqs = transcript.seqs;
      this.sessionStore.setModel(this.session.id, this.modelId);
    }
  }

  getModel(): string {
    return this.modelId;
  }

  setModel(model: string): void {
    const selection = resolveProviderModelSelection({ model, mode: this.mode });
    this.modelId = selection.model;
    if (selection.provider !== this.providerId) {
      this.setProvider(selection.provider);
    }
    if (this.sessionStore && this.session) {
      this.sessionStore.setModel(this.session.id, this.modelId);
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    }
  }

  getMode(): AgentMode {
    return this.mode;
  }

  getProvider(): ProviderId {
    return this.providerId;
  }

  getToolsets(): string[] {
    return [...this.toolsets];
  }

  getSandboxMode(): SandboxMode {
    return this.bash.getSandboxMode();
  }

  setSandboxMode(mode: SandboxMode): void {
    this.bash.setSandboxMode(mode);
  }

  getSandboxSettings(): SandboxSettings {
    return this.bash.getSandboxSettings();
  }

  setSandboxSettings(settings: SandboxSettings): void {
    this.bash.setSandboxSettings(settings);
  }

  setMode(mode: AgentMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      const modeModel = getModeSpecificModel(mode);
      if (modeModel) {
        const selection = resolveProviderModelSelection({ provider: this.providerId, model: modeModel, mode });
        this.modelId = selection.model;
        if (selection.provider !== this.providerId) {
          this.setProvider(selection.provider);
        }
      }
      if (this.sessionStore && this.session) {
        this.sessionStore.setMode(this.session.id, mode);
        this.sessionStore.setModel(this.session.id, this.modelId);
        this.session = this.sessionStore.getRequiredSession(this.session.id);
      }
    }
  }

  setPlanContext(ctx: string | null): void {
    this.planContext = ctx;
  }

  setSendTelegramFile(fn: ((filePath: string) => Promise<ToolResult>) | null): void {
    this.sendTelegramFile = fn;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  setApiKey(apiKey: string, baseURL = this.baseURL ?? undefined, providerId: ProviderId = this.providerId): void {
    this.apiKey = apiKey;
    this.providerId = providerId;
    this.baseURL = baseURL || null;
    this.provider = createProvider(apiKey, baseURL, providerId);
    if (providerId !== "xai") {
      this.batchApi = false;
    }
  }

  setProvider(provider: ProviderId | string, apiKey?: string, baseURL?: string): void {
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      throw new Error(`Unknown provider "${provider}".`);
    }
    this.providerId = normalized;
    const resolvedBaseURL = baseURL ?? getBaseURL(normalized);
    const resolvedApiKey = apiKey ?? getApiKey(normalized);
    this.baseURL = resolvedBaseURL || null;
    this.apiKey = null;
    this.provider = null;
    if (resolvedApiKey) {
      this.setApiKey(resolvedApiKey, resolvedBaseURL, normalized);
    }
  }

  getCwd(): string {
    return this.bash.getCwd();
  }

  async listSchedules(): Promise<StoredSchedule[]> {
    return this.schedules.list();
  }

  async removeSchedule(id: string): Promise<string> {
    const removed = await this.schedules.remove(id);
    return removed ? `Removed schedule "${removed.name}".` : `Schedule "${id}" not found.`;
  }

  async getScheduleDaemonStatus(): Promise<ScheduleDaemonStatus> {
    return this.schedules.getDaemonStatus();
  }

  getContextStats(
    contextWindow: number,
    inFlightText = "",
  ): {
    contextWindow: number;
    usedTokens: number;
    remainingTokens: number;
    ratioUsed: number;
    ratioRemaining: number;
  } {
    const system = buildSystemPrompt(
      this.bash.getCwd(),
      this.mode,
      this.bash.getSandboxMode(),
      this.planContext,
      undefined,
      this.bash.getSandboxSettings(),
    );
    const usedTokens = Math.min(contextWindow, estimateConversationTokens(system, this.messages, inFlightText));
    const remainingTokens = Math.max(0, contextWindow - usedTokens);

    return {
      contextWindow,
      usedTokens,
      remainingTokens,
      ratioUsed: usedTokens / contextWindow,
      ratioRemaining: remainingTokens / contextWindow,
    };
  }

  async generateTitle(userMessage: string): Promise<string> {
    const provider = this.provider;
    if (!provider) {
      return "New session";
    }

    const generated = await genTitle(provider, userMessage);
    this.recordUsage(generated.usage, "title", generated.modelId);
    if (this.sessionStore && this.session && !this.session.title && generated.title) {
      this.sessionStore.setTitle(this.session.id, generated.title);
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    }
    return generated.title;
  }

  getSessionRecap(): string | null {
    return this.recapsEnabled ? this.session?.recap?.text || null : null;
  }

  getRecapsEnabled(): boolean {
    return this.recapsEnabled;
  }

  setRecapsEnabled(enabled: boolean): void {
    this.recapsEnabled = enabled;
  }

  async askSideQuestion(question: string, signal?: AbortSignal): Promise<SideQuestionResult> {
    if (!this.provider) {
      return { response: "No API key configured." };
    }

    const contextParts: string[] = [];
    let charBudget = 2000;
    for (let i = this.messages.length - 1; i >= 0 && charBudget > 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p: { type: string }) => p.type === "text")
                .map((p: { type: string; text?: string }) => p.text ?? "")
                .join("")
            : "";
      if (!text) continue;
      const snippet = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      contextParts.unshift(`[${msg.role}]: ${snippet}`);
      charBudget -= snippet.length;
    }
    const conversationContext = contextParts.join("\n\n");

    const result = await runSideQuestion(question, this.provider, this.modelId, conversationContext, signal);
    this.recordUsage(result.usage, "other");
    return result;
  }

  abort(): void {
    this.abortController?.abort();
    this.emitSubagentStatus(null);
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled([this.bash.cleanup(), shutdownWorkspaceLspManager(this.bash.getCwd())]);
  }

  respondToToolApproval(approvalId: string, approved: boolean): void {
    const toolApprovalResponse: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-approval-response" as const,
          approvalId,
          approved,
        },
      ],
    };
    this.messages.push(toolApprovalResponse);
    this.messageSeqs.push(null);
  }

  clearHistory(): void {
    this.startNewSession();
  }

  startNewSession(): SessionSnapshot | null {
    if (this.sessionStartHookFired) {
      const endInput: SessionEndHookInput = {
        hook_event_name: "SessionEnd",
        session_id: this.session?.id,
        cwd: this.bash.getCwd(),
      };
      this.fireHook(endInput).catch(() => {});
      this.sessionStartHookFired = false;
    }

    if (!this.sessionStore) {
      this.messages = [];
      this.messageSeqs = [];
      return null;
    }

    this.sessionStore = new SessionStore(this.bash.getCwd());
    this.workspace = this.sessionStore.getWorkspace();
    this.session = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
    this.messages = [];
    this.messageSeqs = [];
    return this.getSessionSnapshot();
  }

  getSessionInfo(): SessionInfo | null {
    return this.session;
  }

  getSessionId(): string | null {
    return this.session?.id || null;
  }

  getSessionTitle(): string | null {
    return this.session?.title || null;
  }

  getChatEntries(): ChatEntry[] {
    if (!this.session) return [];
    return buildChatEntries(this.session.id);
  }

  getSessionSnapshot(): SessionSnapshot | null {
    if (!this.session || !this.workspace) return null;
    return {
      workspace: this.workspace,
      session: this.session,
      messages: loadTranscript(this.session.id),
      entries: buildChatEntries(this.session.id),
      totalTokens: getSessionTotalTokens(this.session.id),
    };
  }

  onSubagentStatus(listener: (status: SubagentStatus | null) => void): () => void {
    this.subagentStatusListeners.add(listener);
    return () => {
      this.subagentStatusListeners.delete(listener);
    };
  }

  private emitSubagentStatus(status: SubagentStatus | null): void {
    for (const listener of this.subagentStatusListeners) {
      listener(status);
    }
  }

  private discardAbortedTurn(userMessage: ModelMessage): void {
    const idx = this.messages.lastIndexOf(userMessage);
    if (idx >= 0) {
      this.messages.splice(idx, 1);
      this.messageSeqs.splice(idx, 1);
    }
  }

  private async refreshSessionRecap(signal?: AbortSignal): Promise<void> {
    if (!this.recapsEnabled || !this.provider || !this.sessionStore || !this.session) {
      return;
    }

    try {
      const prompt = this.buildRecapPrompt();
      if (!prompt) {
        return;
      }

      const generated = await genRecap(this.provider, prompt, withAbortTimeout(signal, 8_000));
      this.recordUsage(generated.usage, "recap", generated.modelId);
      if (!generated.recap) {
        return;
      }

      this.sessionStore.setRecap(this.session.id, {
        text: generated.recap,
        model: generated.modelId,
        updatedAt: new Date(),
      });
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    } catch {
      // Recaps are best-effort and should never make the completed turn fail.
    }
  }

  private buildRecapPrompt(): string | null {
    if (!this.session) {
      return null;
    }

    const transcript = formatEntriesForRecap(buildChatEntries(this.session.id), 5_000);
    if (!transcript) {
      return null;
    }

    const sections = [
      "Refresh the saved recap for this coding session using the latest transcript.",
      this.session.recap?.text
        ? `Existing recap:\n${truncate(this.session.recap.text, 1_200)}`
        : "Existing recap:\n(none)",
      `Session transcript:\n${transcript}`,
    ];
    return sections.join("\n\n");
  }

  private recordUsage(
    usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
    source: UsageSource = "message",
    model = this.modelId,
  ): void {
    if (!usage) return;
    if (this.session) {
      recordUsageEvent(this.session.id, source, model, usage);
    }
  }

  async consumeBackgroundNotifications(): Promise<string[]> {
    try {
      const notifications = await this.delegations.consumeNotifications();
      for (const notification of notifications) {
        this.messages.push({ role: "system", content: notification.message });
        let seq: number | null = null;
        if (this.session) {
          seq = appendSystemMessage(this.session.id, notification.message);
        }
        this.messageSeqs.push(seq);

        const notifInput: NotificationHookInput = {
          hook_event_name: "Notification",
          message: notification.message,
          session_id: this.session?.id,
          cwd: this.bash.getCwd(),
        };
        this.fireHook(notifInput).catch(() => {});
      }
      return notifications.map((notification) => notification.message);
    } catch {
      return [];
    }
  }

  private getBatchClientOptions(signal?: AbortSignal): BatchClientOptions {
    if (!this.apiKey) {
      throw new Error("API key required. Add an API key to continue.");
    }
    if (this.providerId !== "xai") {
      throw new Error("Batch mode is available only for the native xAI provider.");
    }

    return {
      apiKey: this.apiKey,
      baseURL: this.baseURL ?? undefined,
      signal,
    };
  }

  private async executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }> {
    const tool = tools[toolCall.function.name];
    if (!tool || tool.type === "provider" || typeof tool.execute !== "function") {
      return {
        input: parseToolArgumentsOrRaw(toolCall.function.arguments),
        result: {
          success: false,
          output: `Tool "${toolCall.function.name}" is unavailable in batch mode.`,
        },
      };
    }

    let parsedInput: unknown;
    try {
      parsedInput = toolCall.function.arguments.trim() ? JSON.parse(toolCall.function.arguments) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        input: toolCall.function.arguments,
        result: {
          success: false,
          output: `Tool "${toolCall.function.name}" received invalid JSON arguments: ${message}`,
        },
      };
    }

    try {
      const output = await tool.execute(parsedInput as never, {
        toolCallId: toolCall.id,
        messages,
        abortSignal: signal,
      });
      return {
        input: parsedInput,
        result: toToolResult(output),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        input: parsedInput,
        result: {
          success: false,
          output: `Tool "${toolCall.function.name}" failed: ${message}`,
        },
      };
    }
  }

  private async runTaskRequestBatch(args: {
    request: TaskRequest;
    childMessages: ModelMessage[];
    childSystem: string;
    childRuntime: ReturnType<typeof resolveModelRuntime>;
    childTools: ToolSet;
    maxSteps: number;
    initialDetail: string;
    onActivity?: (detail: string) => void;
    signal?: AbortSignal;
  }): Promise<ToolResult> {
    const {
      request,
      childMessages,
      childSystem,
      childRuntime,
      childTools,
      maxSteps,
      initialDetail,
      onActivity,
      signal,
    } = args;

    if (childRuntime.modelInfo?.responsesOnly) {
      throw new Error("Batch mode currently supports chat-completions models only.");
    }

    const batchTools =
      childRuntime.modelInfo?.supportsClientTools === false ? [] : await toolSetToBatchTools(childTools);
    const batch = await createBatch({
      ...this.getBatchClientOptions(signal),
      name: buildBatchName(`task-${request.agent}`, request.description),
    });

    const turnMessages: ModelMessage[] = [];
    const totalUsage: ProcessMessageUsage = {};
    let assistantText = "";
    let lastActivity = initialDetail;

    for (let round = 0; round < maxSteps; round++) {
      const batchRequestId = `task-${Date.now()}-${round + 1}`;
      await addBatchRequests({
        ...this.getBatchClientOptions(signal),
        batchId: batch.batch_id,
        batchRequests: [
          {
            batch_request_id: batchRequestId,
            batch_request: {
              chat_get_completion: buildBatchChatCompletionRequest({
                modelId: childRuntime.modelId,
                system: childSystem,
                messages: [...childMessages, ...turnMessages],
                temperature: request.agent === "explore" ? 0.2 : 0.5,
                maxOutputTokens:
                  childRuntime.modelInfo?.supportsMaxOutputTokens === false
                    ? undefined
                    : Math.min(this.maxTokens, 8_192),
                reasoningEffort: childRuntime.providerOptions?.xai?.reasoningEffort,
                tools: batchTools,
              }),
            },
          },
        ],
      });

      const result = await pollBatchRequestResult({
        ...this.getBatchClientOptions(signal),
        batchId: batch.batch_id,
        batchRequestId,
      });
      const response = getBatchChatCompletion(result);
      accumulateUsage(totalUsage, getBatchUsage(response));

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("Batch response did not contain any choices.");
      }
      const content = choice?.message.content ?? "";
      if (content) {
        assistantText += content;
      }

      const requestMessages = [...childMessages, ...turnMessages];
      const toolCalls = (choice?.message.tool_calls ?? []).map(toLocalToolCall);
      const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
      if (assistantMessage) {
        turnMessages.push(assistantMessage);
      }

      if (toolCalls.length === 0) {
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "task", childRuntime.modelId);
        }
        const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
        return {
          success: true,
          output,
          task: {
            agent: request.agent,
            description: request.description,
            summary: firstLine(output),
            activity: lastActivity,
          },
        };
      }

      const toolParts: ExecutedBatchTool[] = [];
      for (const toolCall of toolCalls) {
        const nextActivity = formatSubagentActivity(
          toolCall.function.name,
          parseToolArgumentsOrRaw(toolCall.function.arguments),
        );
        lastActivity = nextActivity;
        onActivity?.(nextActivity);

        const executed = await this.executeBatchToolCall(childTools, toolCall, requestMessages, signal);
        toolParts.push({
          toolCall,
          input: executed.input,
          toolResult: executed.result,
        });
      }

      const toolMessage = buildToolBatchMessage(toolParts);
      if (toolMessage) {
        turnMessages.push(toolMessage);
      }
    }

    if (hasUsage(totalUsage)) {
      this.recordUsage(totalUsage, "task", childRuntime.modelId);
    }
    const output = assistantText.trim() || `Task stopped after ${maxSteps} batch rounds. Last action: ${lastActivity}`;
    return {
      success: false,
      output,
      task: {
        agent: request.agent,
        description: request.description,
        summary: output,
        activity: lastActivity,
      },
    };
  }

  async runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const provider = this.requireProvider();
    const signal = abortSignal;
    const agentKey = String(request.agent);
    const isExplore = agentKey === "explore";
    const isGeneral = agentKey === "general";
    const isVision = agentKey === "vision";
    const isVerify = agentKey === "verify";
    const isVerifyDetect = agentKey === "verify-detect";
    const isVerifyManifest = agentKey === "verify-manifest";
    const isComputer = agentKey === "computer";
    const subagents = loadValidSubAgents();
    const custom =
      !isExplore && !isGeneral && !isVision && !isVerify && !isVerifyDetect && !isVerifyManifest && !isComputer
        ? findCustomSubagent(agentKey, subagents)
        : undefined;

    if (
      !isExplore &&
      !isGeneral &&
      !isVision &&
      !isVerify &&
      !isVerifyDetect &&
      !isVerifyManifest &&
      !isComputer &&
      !custom
    ) {
      const message = `Unknown sub-agent "${agentKey}". Use general, explore, vision, verify, verify-detect, verify-manifest, computer, or a configured name from ~/.clawd/user-settings.json.`;
      return {
        success: false,
        output: message,
        task: {
          agent: agentKey,
          description: request.description,
          summary: message,
        },
      };
    }

    const childMode: AgentMode = isExplore || isVerifyDetect ? "ask" : "agent";
    const verifySandboxOverrides: SandboxSettings = isVerify
      ? { allowNet: true, allowedHosts: undefined, allowEphemeralInstall: true, hostBrowserCommandsOnHost: true }
      : {};
    let verifyPreparedSettings: SandboxSettings | null = null;
    let verifyPreparedRecipe: VerifyRecipe | null = null;
    if (isVerify) {
      const prepared = await prepareVerifySandbox(
        this.bash.getCwd(),
        { ...this.bash.getSandboxSettings(), ...verifySandboxOverrides },
        undefined,
        onActivity,
      );
      verifyPreparedSettings = prepared.sandboxSettings;
      verifyPreparedRecipe = prepared.profile.recipe;
    }
    const childBash = new BashTool(this.bash.getCwd(), {
      sandboxMode: isVerify ? "shuru" : this.bash.getSandboxMode(),
      sandboxSettings: isVerify
        ? (verifyPreparedSettings ?? { ...this.bash.getSandboxSettings(), ...verifySandboxOverrides })
        : this.bash.getSandboxSettings(),
    });
    const childBaseTools = createTools(childBash, provider, childMode, { toolsets: this.toolsets });
    const initialDetail = isExplore
      ? "Scanning the codebase"
      : isVerifyDetect
        ? "Detecting verification recipe"
        : isVerifyManifest
          ? "Creating verification manifest"
          : isVerify
            ? "Preparing verification pass"
            : isComputer
              ? "Preparing computer control pass"
              : "Planning delegated work";
    let assistantText = "";
    let lastActivity = initialDetail;
    let childTools: ToolSet = childBaseTools;
    let closeMcp: (() => Promise<void>) | undefined;
    const childModelId = normalizeModelId(
      isVision
        ? VISION_MODEL
        : isComputer
          ? COMPUTER_MODEL
          : isExplore
            ? DEFAULT_MODEL
            : custom
              ? custom.model
              : this.modelId,
    );
    const childRuntime = isVision ? resolveResponsesRuntime(provider, childModelId) : resolveModelRuntime(provider, childModelId);
    if (isComputer && childRuntime.modelInfo?.supportsClientTools === false) {
      return {
        success: false,
        output:
          "Computer sub-agent requires a tool-capable model, but the selected runtime does not support client tools.",
        task: {
          agent: agentKey,
          description: request.description,
          summary: "Computer sub-agent could not start because the chosen model does not support tools.",
        },
      };
    }
    const childSystem = applyModelConstraints(
      buildSubagentPrompt(
        request,
        childBash.getCwd(),
        custom ?? null,
        childBash.getSandboxMode(),
        subagents,
        childBash.getSandboxSettings(),
      ),
      childRuntime.modelId,
    );

    onActivity?.(initialDetail);

    try {
      if (childMode === "agent" && childRuntime.modelInfo?.supportsClientTools !== false) {
        const mcpBundle = await buildMcpToolSet(loadMcpServers());
        closeMcp = mcpBundle.close;
        childTools = { ...childBaseTools, ...mcpBundle.tools };
        if (mcpBundle.errors.length > 0) {
          lastActivity = `MCP unavailable: ${mcpBundle.errors.join(" | ")}`;
          onActivity?.(lastActivity);
        }
      }

      const childPrompt =
        isVerify && verifyPreparedRecipe
          ? `${request.prompt}\n\nPrepared verify recipe JSON (use this as the primary execution recipe and keep .clawd/environment.json aligned with it if present):\n${JSON.stringify(verifyPreparedRecipe, null, 2)}`
          : request.prompt;

      const childMessages = isVision
        ? await buildVisionUserMessages(request.prompt, childBash.getCwd(), signal)
        : [{ role: "user" as const, content: childPrompt }];

      if (this.batchApi) {
        return await this.runTaskRequestBatch({
          request,
          childMessages,
          childSystem,
          childRuntime,
          childTools,
          maxSteps: Math.min(this.maxToolRounds, isExplore ? 60 : 120),
          initialDetail,
          onActivity,
          signal,
        });
      }

      const result = streamText({
        model: childRuntime.model,
        system: childSystem,
        messages: childMessages,
        tools: childRuntime.modelInfo?.supportsClientTools === false ? {} : childTools,
        stopWhen: stepCountIs(Math.min(this.maxToolRounds, isExplore ? 60 : 120)),
        maxRetries: 0,
        abortSignal: signal,
        temperature: isExplore ? 0.2 : 0.5,
        ...(childRuntime.modelInfo?.supportsMaxOutputTokens === false
          ? {}
          : { maxOutputTokens: Math.min(this.maxTokens, 8_192) }),
        ...(childRuntime.providerOptions ? { providerOptions: childRuntime.providerOptions } : {}),
        onFinish: ({ totalUsage }) => {
          this.recordUsage(totalUsage, "task", childRuntime.modelId);
        },
      });

      for await (const part of result.fullStream) {
        if (signal?.aborted) {
          break;
        }

        if (part.type === "text-delta") {
          assistantText += part.text;
          continue;
        }

        if (part.type === "tool-call") {
          lastActivity = formatSubagentActivity(part.toolName, part.input);
          onActivity?.(lastActivity);
        }
      }

      if (signal?.aborted) {
        return { success: false, output: "[Cancelled]" };
      }

      await result.response;

      const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
      return {
        success: true,
        output,
        task: {
          agent: request.agent,
          description: request.description,
          summary: firstLine(output),
          activity: lastActivity,
        },
      };
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const output = `Task failed: ${msg}`;
      return {
        success: false,
        output,
        task: {
          agent: request.agent,
          description: request.description,
          summary: output,
          activity: lastActivity,
        },
      };
    } finally {
      await closeMcp?.().catch(() => {});
    }
  }

  private async runTask(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    const startInput: SubagentStartHookInput = {
      hook_event_name: "SubagentStart",
      agent_type: request.agent,
      description: request.description,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(startInput, abortSignal).catch(() => {});

    let result: ToolResult;
    try {
      result = await this.runTaskRequest(
        request,
        (detail) => {
          if (abortSignal?.aborted) return;
          this.emitSubagentStatus({
            agent: request.agent,
            description: request.description,
            detail,
          });
        },
        abortSignal,
      );
    } finally {
      this.emitSubagentStatus(null);
    }

    const stopInput: SubagentStopHookInput = {
      hook_event_name: "SubagentStop",
      agent_type: request.agent,
      description: request.description,
      success: result.success,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(stopInput, abortSignal).catch(() => {});

    return result;
  }

  private async runDelegation(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    const taskCreatedInput: TaskCreatedHookInput = {
      hook_event_name: "TaskCreated",
      agent_type: request.agent,
      description: request.description,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(taskCreatedInput, abortSignal).catch(() => {});

    let result: ToolResult;
    try {
      if (abortSignal?.aborted) {
        return { success: false, output: "[Cancelled]" };
      }

      result = await this.delegations.start(request, {
        model: this.modelId,
        sandboxMode: this.bash.getSandboxMode(),
        sandboxSettings: this.bash.getSandboxSettings(),
        maxToolRounds: this.maxToolRounds,
        maxTokens: this.maxTokens,
        batchApi: this.batchApi,
      });
    } catch (err: unknown) {
      if (abortSignal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        output: `Delegation failed: ${msg}`,
      };
    }

    const taskCompletedInput: TaskCompletedHookInput = {
      hook_event_name: "TaskCompleted",
      agent_type: request.agent,
      description: request.description,
      success: result.success,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(taskCompletedInput, abortSignal).catch(() => {});

    return result;
  }

  private async readDelegation(id: string): Promise<ToolResult> {
    try {
      return {
        success: true,
        output: await this.delegations.read(id),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to read delegation: ${msg}`,
      };
    }
  }

  private async listDelegations(): Promise<ToolResult> {
    try {
      const delegations = await this.delegations.list();
      if (delegations.length === 0) {
        return {
          success: true,
          output: "No delegations found for this project.",
        };
      }

      const lines = delegations.map((delegation) => {
        const title = delegation.description || delegation.id;
        return `- \`${delegation.id}\` [${delegation.status}] ${title}\n  ${delegation.summary}`;
      });

      return {
        success: true,
        output: `## Delegations\n\n${lines.join("\n")}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to list delegations: ${msg}`,
      };
    }
  }

  private getCompactionSettings(): CompactionSettings {
    return {
      reserveTokens: Math.max(this.maxTokens, DEFAULT_RESERVE_TOKENS),
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    };
  }

  private async compactForContext(
    provider: XaiProvider,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings = this.getCompactionSettings(),
    force = false,
  ): Promise<boolean> {
    if (!this.session) return false;

    const preparation = prepareCompaction(this.messages, system, settings);
    if (!preparation) return false;
    if (!force && !shouldCompactContext(preparation.tokensBefore, contextWindow, settings)) {
      return false;
    }

    const trigger = force ? "manual" : "auto";
    const preCompactInput: PreCompactHookInput = {
      hook_event_name: "PreCompact",
      trigger,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(preCompactInput, signal).catch(() => {});

    const keptSeqs = this.messageSeqs.slice(preparation.firstKeptIndex);
    const firstKeptSeq = keptSeqs.find((seq): seq is number => seq !== null) ?? getNextMessageSequence(this.session.id);
    const summary = await generateCompactionSummary(provider, this.modelId, preparation, undefined, signal);

    appendCompaction(this.session.id, firstKeptSeq, summary, preparation.tokensBefore);
    this.messages = [createCompactionSummaryMessage(summary), ...preparation.keptMessages];
    this.messageSeqs = [null, ...keptSeqs];

    const postCompactInput: PostCompactHookInput = {
      hook_event_name: "PostCompact",
      trigger,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(postCompactInput, signal).catch(() => {});

    return true;
  }

  private async *processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: XaiProvider;
    subagents: CustomSubagentConfig[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown> {
    const { userModelMessage, observer, provider, subagents, system, runtime, modelInfo, signal } = args;
    let attemptedOverflowRecovery = false;

    while (true) {
      let closeMcp: (() => Promise<void>) | undefined;
      const turnMessages: ModelMessage[] = [];
      const totalUsage: ProcessMessageUsage = {};

      try {
        const settings = attemptedOverflowRecovery
          ? relaxCompactionSettings(this.getCompactionSettings())
          : this.getCompactionSettings();
        if (modelInfo) {
          await this.compactForContext(
            provider,
            system,
            modelInfo.contextWindow,
            signal,
            settings,
            attemptedOverflowRecovery,
          );
        }

        if (runtime.modelInfo?.responsesOnly) {
          throw new Error("Batch mode currently supports chat-completions models only.");
        }

        const baseTools = createTools(this.bash, provider, this.mode, {
          runTask: (request, abortSignal) => this.runTask(request, combineAbortSignals(signal, abortSignal)),
          runDelegation: (request, abortSignal) =>
            this.runDelegation(request, combineAbortSignals(signal, abortSignal)),
          readDelegation: (id) => this.readDelegation(id),
          listDelegations: () => this.listDelegations(),
          scheduleManager: this.schedules,
          subagents,
          sendTelegramFile: this.sendTelegramFile ?? undefined,
          sessionId: this.session?.id ?? undefined,
          toolsets: this.toolsets,
        });
        let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : baseTools;
        if (this.mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
          const mcpBundle = await buildMcpToolSet(loadMcpServers());
          closeMcp = mcpBundle.close;
          tools = { ...baseTools, ...mcpBundle.tools };
          if (mcpBundle.errors.length > 0) {
            yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
          }
        }

        const batchTools = runtime.modelInfo?.supportsClientTools === false ? [] : await toolSetToBatchTools(tools);
        const batch = await createBatch({
          ...this.getBatchClientOptions(signal),
          name: buildBatchName("session", this.getSessionId() || runtime.modelId),
        });

        for (let round = 0; round < this.maxToolRounds; round++) {
          const stepNumber = round + 1;
          notifyObserver(observer?.onStepStart, {
            stepNumber,
            timestamp: Date.now(),
          });

          const batchRequestId = `turn-${Date.now()}-${stepNumber}`;
          await addBatchRequests({
            ...this.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequests: [
              {
                batch_request_id: batchRequestId,
                batch_request: {
                  chat_get_completion: buildBatchChatCompletionRequest({
                    modelId: runtime.modelId,
                    system,
                    messages: [...this.messages, ...turnMessages],
                    temperature: 0.7,
                    maxOutputTokens: runtime.modelInfo?.supportsMaxOutputTokens === false ? undefined : this.maxTokens,
                    reasoningEffort: runtime.providerOptions?.xai?.reasoningEffort,
                    tools: batchTools,
                  }),
                },
              },
            ],
          });

          const result = await pollBatchRequestResult({
            ...this.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequestId,
          });
          const response = getBatchChatCompletion(result);
          const choice = response.choices[0];
          if (!choice) {
            throw new Error("Batch response did not contain any choices.");
          }

          const usage = getBatchUsage(response);
          accumulateUsage(totalUsage, usage);
          const finishReason = getBatchFinishReason(choice.finish_reason);

          const content = choice.message.content ?? "";
          if (content) {
            yield { type: "content", content };
          }

          const requestMessages = [...this.messages, ...turnMessages];
          const toolCalls = (choice.message.tool_calls ?? []).map(toLocalToolCall);
          const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
          if (assistantMessage) {
            turnMessages.push(assistantMessage);
          }

          if (toolCalls.length === 0) {
            notifyObserver(observer?.onStepFinish, {
              stepNumber,
              timestamp: Date.now(),
              finishReason,
              usage,
            });
            if (hasUsage(totalUsage)) {
              this.recordUsage(totalUsage, "message", runtime.modelId);
            }
            this.appendCompletedTurn(userModelMessage, turnMessages);
            await this.refreshSessionRecap(signal);
            yield { type: "done" };
            return;
          }

          yield { type: "tool_calls", toolCalls };

          const toolParts: ExecutedBatchTool[] = [];
          for (const toolCall of toolCalls) {
            notifyObserver(observer?.onToolStart, {
              toolCall,
              timestamp: Date.now(),
            });

            const executed = await this.executeBatchToolCall(tools, toolCall, requestMessages, signal);
            notifyObserver(observer?.onToolFinish, {
              toolCall,
              toolResult: executed.result,
              timestamp: Date.now(),
            });
            yield { type: "tool_result", toolCall, toolResult: executed.result };
            toolParts.push({
              toolCall,
              input: executed.input,
              toolResult: executed.result,
            });
          }

          const toolMessage = buildToolBatchMessage(toolParts);
          if (toolMessage) {
            turnMessages.push(toolMessage);
          }
          notifyObserver(observer?.onStepFinish, {
            stepNumber,
            timestamp: Date.now(),
            finishReason,
            usage,
          });
        }

        const message = `Error: Reached max tool rounds (${this.maxToolRounds}) in batch mode.`;
        notifyObserver(observer?.onError, {
          message,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "message", runtime.modelId);
        }
        this.appendCompletedTurn(userModelMessage, turnMessages);
        yield { type: "error", content: message };
        yield { type: "done" };
        return;
      } catch (err: unknown) {
        if (signal.aborted) {
          this.discardAbortedTurn(userModelMessage);
          yield { type: "content", content: "\n\n[Cancelled]" };
          yield { type: "done" };
          return;
        }

        if (!attemptedOverflowRecovery && turnMessages.length === 0 && modelInfo && isContextLimitError(err)) {
          attemptedOverflowRecovery = true;
          continue;
        }

        const authError = isAuthenticationError(err);
        const friendly = humanizeApiError(err);
        notifyObserver(observer?.onError, {
          message: friendly,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "message", runtime.modelId);
        }
        this.appendCompletedTurn(userModelMessage, turnMessages);
        yield {
          type: "error",
          content: friendly,
          isAuthError: authError,
        };
        yield { type: "done" };
        return;
      } finally {
        await closeMcp?.().catch(() => {});
      }
    }
  }

  private appendCompletedTurn(userMessage: ModelMessage, newMessages: ModelMessage[]): void {
    if (newMessages.length === 0) return;

    const userIndex = this.messages.lastIndexOf(userMessage);
    if (!this.sessionStore || !this.session) {
      if (userIndex >= 0 && this.messageSeqs[userIndex] == null) {
        this.messageSeqs[userIndex] = null;
      }
      this.messages.push(...newMessages);
      this.messageSeqs.push(...newMessages.map(() => null));
      return;
    }

    const insertedSeqs = appendMessages(this.session.id, [userMessage, ...newMessages]);
    if (userIndex >= 0) {
      this.messageSeqs[userIndex] = insertedSeqs[0] ?? this.messageSeqs[userIndex];
    }
    this.messages.push(...newMessages);
    this.messageSeqs.push(...insertedSeqs.slice(1));
    this.sessionStore.touchSession(this.session.id, this.bash.getCwd());
    this.session = this.sessionStore.getRequiredSession(this.session.id);
  }

  private fireHook(
    input: Parameters<typeof executeEventHooks>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof executeEventHooks>>> {
    return executeEventHooks(input, this.bash.getCwd(), signal);
  }

  async *processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.abortController = new AbortController();
    const signal = this.abortController!.signal;
    this.emitSubagentStatus(null);

    if (!this.sessionStartHookFired) {
      this.sessionStartHookFired = true;
      const isResume = this.messages.length > 0;
      const sessionStartInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        source: isResume ? "resume" : "startup",
        session_id: this.session?.id,
        cwd: this.bash.getCwd(),
      };
      await this.fireHook(sessionStartInput, signal).catch(() => {});
    }

    const promptInput: UserPromptSubmitHookInput = {
      hook_event_name: "UserPromptSubmit",
      user_prompt: userMessage,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(promptInput, signal).catch(() => {});

    await this.consumeBackgroundNotifications();
    const userModelMessages = await buildVisionUserMessages(userMessage, this.bash.getCwd(), signal);
    const userModelMessage = userModelMessages[0] ?? ({ role: "user", content: userMessage } satisfies ModelMessage);
    this.messages.push(userModelMessage);
    this.messageSeqs.push(null);

    const provider = this.requireProvider();
    const subagents = loadValidSubAgents();
    const system = applyModelConstraints(
      buildSystemPrompt(
        this.bash.getCwd(),
        this.mode,
        this.bash.getSandboxMode(),
        this.planContext,
        subagents,
        this.bash.getSandboxSettings(),
      ),
      this.modelId,
    );
    const runtime = resolveModelRuntime(provider, this.modelId);
    const modelInfo = runtime.modelInfo;
    this.planContext = null;
    let attemptedOverflowRecovery = false;

    if (this.batchApi) {
      try {
        yield* this.processMessageBatchTurn({
          userModelMessage,
          observer,
          provider,
          subagents,
          system,
          runtime,
          modelInfo,
          signal,
        });
      } finally {
        if (this.abortController?.signal === signal) {
          this.abortController = null;
        }
      }
      return;
    }

    try {
      while (true) {
        let assistantText = "";
        let reasoningPreview = "";
        let encryptedReasoningHidden = false;
        let streamOk = false;
        let closeMcp: (() => Promise<void>) | undefined;
        let stepNumber = -1;
        const activeToolCalls: ToolCall[] = [];

        try {
          const settings = attemptedOverflowRecovery
            ? relaxCompactionSettings(this.getCompactionSettings())
            : this.getCompactionSettings();
          if (modelInfo) {
            await this.compactForContext(
              provider,
              system,
              modelInfo.contextWindow,
              signal,
              settings,
              attemptedOverflowRecovery,
            );
          }

          const baseTools = createTools(this.bash, provider, this.mode, {
            runTask: (request, abortSignal) => this.runTask(request, combineAbortSignals(signal, abortSignal)),
            runDelegation: (request, abortSignal) =>
              this.runDelegation(request, combineAbortSignals(signal, abortSignal)),
            readDelegation: (id) => this.readDelegation(id),
            listDelegations: () => this.listDelegations(),
            scheduleManager: this.schedules,
            subagents,
            sendTelegramFile: this.sendTelegramFile ?? undefined,
            sessionId: this.session?.id ?? undefined,
            toolsets: this.toolsets,
          });
          let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : baseTools;
          if (this.mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
            const mcpBundle = await buildMcpToolSet(loadMcpServers());
            closeMcp = mcpBundle.close;
            tools = { ...baseTools, ...mcpBundle.tools };
            if (mcpBundle.errors.length > 0) {
              yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
            }
          }

          const result = streamText({
            model: runtime.model,
            system,
            messages: this.messages,
            tools,
            stopWhen: stepCountIs(this.maxToolRounds),
            maxRetries: 0,
            abortSignal: signal,
            temperature: 0.7,
            ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: this.maxTokens }),
            ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
            experimental_onStepStart: (event: unknown) => {
              stepNumber = getStepNumber(event, stepNumber + 1);
              notifyObserver(observer?.onStepStart, {
                stepNumber,
                timestamp: Date.now(),
              });
            },
            onStepFinish: (event: unknown) => {
              const currentStep = getStepNumber(event, Math.max(stepNumber, 0));
              stepNumber = Math.max(stepNumber, currentStep);
              notifyObserver(observer?.onStepFinish, {
                stepNumber: currentStep,
                timestamp: Date.now(),
                finishReason: getFinishReason(event),
                usage: getUsage(event),
              });
            },
            onFinish: ({ totalUsage }) => {
              this.recordUsage(totalUsage, "message", runtime.modelId);
            },
          });

          for await (const part of result.fullStream) {
            if (signal.aborted) {
              yield { type: "content", content: "\n\n[Cancelled]" };
              break;
            }

            switch (part.type) {
              case "text-delta":
                assistantText += part.text;
                yield { type: "content", content: part.text };
                break;

              case "reasoning-delta":
                reasoningPreview = `${reasoningPreview}${part.text}`.slice(-256);
                if (containsEncryptedReasoning(reasoningPreview)) {
                  if (!encryptedReasoningHidden) {
                    encryptedReasoningHidden = true;
                    yield { type: "reasoning", content: "[Encrypted reasoning hidden]" };
                  }
                  break;
                }
                yield { type: "reasoning", content: part.text };
                break;

              case "tool-call": {
                const tc = toToolCall(part);
                activeToolCalls.push(tc);
                notifyObserver(observer?.onToolStart, {
                  toolCall: tc,
                  timestamp: Date.now(),
                });
                yield { type: "tool_calls", toolCalls: [tc] };
                break;
              }

              case "tool-result": {
                const tc: ToolCall = {
                  id: part.toolCallId,
                  type: "function",
                  function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
                };
                const tr = toToolResult(part.output);
                notifyObserver(observer?.onToolFinish, {
                  toolCall: tc,
                  toolResult: tr,
                  timestamp: Date.now(),
                });
                yield { type: "tool_result", toolCall: tc, toolResult: tr };
                break;
              }

              case "tool-approval-request": {
                const approvalPart = part as unknown as {
                  approvalId: string;
                  toolCall: { toolCallId: string; toolName: string; input: unknown };
                };
                const toolCallId = approvalPart.toolCall?.toolCallId ?? "";
                const pendingTc = activeToolCalls.find((tc) => tc.id === toolCallId);
                const tcForChunk = pendingTc ?? {
                  id: toolCallId,
                  type: "function" as const,
                  function: {
                    name: approvalPart.toolCall?.toolName ?? "paid_request",
                    arguments: JSON.stringify(approvalPart.toolCall?.input ?? {}),
                  },
                };

                let paymentPrecheck: import("../types/index").PaymentPrecheck | undefined;
                if (approvalPart.toolCall?.toolName === "paid_request") {
                  try {
                    const input = approvalPart.toolCall.input as { url?: string; method?: string } | null;
                    const url = input?.url;
                    if (url) {
                      const { scanUrl } = await import("../payments/brin");
                      const brin = await scanUrl(url);
                      if (brin) {
                        const securityRaw = `${brin.score}/100 (${brin.verdict}, ${brin.confidence} confidence)`;
                        paymentPrecheck = {
                          security: securityRaw,
                          securityLabel: securityRaw,
                          securityUrl: brin.url ?? "",
                        };
                      }

                      const probeRes = await fetch(url, {
                        method: input?.method ?? "GET",
                        signal: AbortSignal.timeout(3_000),
                      });
                      if (probeRes.status === 402) {
                        const header = probeRes.headers.get("payment-required");
                        if (header) {
                          const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
                          const opts = decoded.accepts ?? [];
                          if (opts.length > 0) {
                            const opt = opts[0];
                            paymentPrecheck = {
                              ...paymentPrecheck,
                              amount: opt.amount ?? opt.maxAmountRequired ?? opt.price ?? "",
                              network: opt.network ?? "",
                              asset: opt.asset ?? "",
                              description: decoded.resource?.description ?? decoded.description ?? "",
                            };
                          }
                        }
                      }
                    }
                  } catch {
                    // pre-check is best-effort
                  }
                }

                yield {
                  type: "tool_approval_request",
                  approvalId: approvalPart.approvalId,
                  toolCall: tcForChunk,
                  paymentPrecheck,
                };
                break;
              }

              case "error": {
                const authError = isAuthenticationError(part.error);
                const friendly = humanizeApiError(part.error);
                notifyObserver(observer?.onError, {
                  message: friendly,
                  timestamp: Date.now(),
                });
                yield {
                  type: "error",
                  content: friendly,
                  isAuthError: authError,
                };
                break;
              }

              case "abort":
                yield { type: "content", content: "\n\n[Cancelled]" };
                break;
            }
          }

          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          try {
            const response = await result.response;
            if (!signal.aborted) {
              this.appendCompletedTurn(userModelMessage, sanitizeModelMessages(response.messages));
              await this.refreshSessionRecap(signal);
              streamOk = true;
            }
          } catch (responseError: unknown) {
            if (
              !attemptedOverflowRecovery &&
              !assistantText.trim() &&
              modelInfo &&
              isContextLimitError(responseError)
            ) {
              attemptedOverflowRecovery = true;
              continue;
            }
          }

          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          if (!streamOk && assistantText.trim()) {
            this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
            await this.refreshSessionRecap(signal);
          }

          const stopInput: StopHookInput = {
            hook_event_name: "Stop",
            session_id: this.session?.id,
            cwd: this.bash.getCwd(),
          };
          await this.fireHook(stopInput, signal).catch(() => {});

          yield { type: "done" };
          return;
        } catch (err: unknown) {
          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
            yield { type: "content", content: "\n\n[Cancelled]" };
            yield { type: "done" };
            return;
          }

          if (!attemptedOverflowRecovery && !assistantText.trim() && modelInfo && isContextLimitError(err)) {
            attemptedOverflowRecovery = true;
            continue;
          }

          const authError = isAuthenticationError(err);
          const friendly = humanizeApiError(err);
          notifyObserver(observer?.onError, {
            message: friendly,
            timestamp: Date.now(),
          });
          yield {
            type: "error",
            content: friendly,
            isAuthError: authError,
          };
          if (assistantText.trim()) {
            this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
          }

          const stopFailureInput: StopFailureHookInput = {
            hook_event_name: "StopFailure",
            error: friendly,
            session_id: this.session?.id,
            cwd: this.bash.getCwd(),
          };
          await this.fireHook(stopFailureInput, signal).catch(() => {});

          yield { type: "done" };
          return;
        } finally {
          await closeMcp?.().catch(() => {});
        }
      }
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }

  private requireProvider(): XaiProvider {
    if (!this.provider) {
      throw new Error("API key required. Add an API key to continue.");
    }

    return this.provider;
  }

  async detectVerifyRecipe(settings?: SandboxSettings, abortSignal?: AbortSignal): Promise<VerifyRecipe | null> {
    try {
      const result = await this.runTaskRequest(
        {
          agent: "verify-detect",
          description: "Detect verification recipe",
          prompt: buildVerifyDetectPrompt(this.bash.getCwd(), settings ?? this.bash.getSandboxSettings()),
        },
        undefined,
        abortSignal,
      );
      if (!result.success || !result.output) return null;
      const maybeJson = extractJsonObject(result.output);
      if (!maybeJson) return null;
      return normalizeVerifyRecipe(JSON.parse(maybeJson));
    } catch {
      return null;
    }
  }

  async runVerify(onProgress?: (detail: string) => void, abortSignal?: AbortSignal): Promise<ToolResult> {
    this.abortController = new AbortController();
    const signal = abortSignal ?? this.abortController!.signal;
    const userModelMessage: ModelMessage = { role: "user", content: "/verify" };
    this.messages.push(userModelMessage);
    this.messageSeqs.push(null);

    try {
      await this.consumeBackgroundNotifications();
      const result = await runVerifyOrchestration(this, { onProgress, abortSignal: signal });
      const assistantText = result.output || result.error || "Verification completed.";
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const failureText = signal.aborted ? "Verification aborted." : `Verification failed: ${msg}`;
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: failureText }]);
      return { success: false, output: failureText };
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }
}

interface ExecutedBatchTool {
  toolCall: ToolCall;
  input: unknown;
  toolResult: ToolResult;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

function buildBatchName(prefix: string, label: string): string {
  const compact =
    label
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "")
      .slice(0, 48) || "run";
  return `clawd-${prefix}-${compact}`;
}

function buildBatchChatCompletionRequest(args: {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens?: number;
  reasoningEffort?: BatchChatCompletionRequest["reasoning_effort"];
  tools: BatchFunctionTool[];
}): BatchChatCompletionRequest {
  return {
    model: args.modelId,
    messages: toBatchChatMessages(args.system, args.messages),
    temperature: args.temperature,
    ...(args.maxOutputTokens != null ? { max_completion_tokens: args.maxOutputTokens } : {}),
    ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
    ...(args.tools.length > 0 ? { tools: args.tools } : {}),
  };
}

function toBatchChatMessages(system: string, messages: ModelMessage[]): BatchChatMessage[] {
  const batchMessages: BatchChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const { role, content } = message;

    switch (role) {
      case "system":
        batchMessages.push({ role: "system", content });
        break;

      case "user": {
        if (typeof content === "string") {
          batchMessages.push({ role: "user", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        if (content.length === 1 && content[0]?.type === "text") {
          batchMessages.push({ role: "user", content: content[0].text });
          break;
        }

        const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> =
          [];
        for (const part of content) {
          switch (part.type) {
            case "text":
              userContent.push({ type: "text", text: part.text });
              break;

            case "image": {
              const mediaType = part.mediaType === "image/*" || !part.mediaType ? "image/jpeg" : part.mediaType;
              const data =
                part.image instanceof URL
                  ? part.image.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.image as string | ArrayBuffer | Uint8Array)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }

            case "file": {
              if (!part.mediaType.startsWith("image/")) {
                break;
              }
              const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType;
              const data =
                part.data instanceof URL
                  ? part.data.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.data as string | ArrayBuffer | Uint8Array)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }
          }
        }
        batchMessages.push({
          role: "user",
          content: userContent,
        });
        break;
      }

      case "assistant": {
        if (typeof content === "string") {
          batchMessages.push({ role: "assistant", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        let assistantText = "";
        const toolCalls: BatchToolCall[] = [];
        for (const part of content) {
          if (part.type === "text") {
            assistantText += part.text;
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
          }
        }

        if (assistantText || toolCalls.length > 0) {
          batchMessages.push({
            role: "assistant",
            content: assistantText,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        break;
      }

      case "tool":
        for (const part of content) {
          if (part.type === "tool-approval-response") {
            continue;
          }
          batchMessages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: toolOutputToText(part.output),
          });
        }
        break;
    }
  }

  return batchMessages;
}

function toBase64DataContent(value: string | Uint8Array | ArrayBuffer): string {
  return convertToBase64(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function toolOutputToText(output: {
  type: "text" | "json" | "execution-denied" | "error-text" | "error-json" | "content";
  value?: unknown;
  reason?: string;
}): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return String(output.value ?? "");
    case "execution-denied":
      return output.reason ?? "Tool execution denied.";
    case "json":
    case "error-json":
    case "content":
      return JSON.stringify(output.value ?? null);
  }
}

function getBatchUsage(response: BatchChatCompletionResponse): ProcessMessageUsage {
  const usage = response.usage ?? {};
  const inputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.total_tokens) ?? sumDefined(inputTokens, outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsdTicks: asNumber(usage.cost_in_usd_ticks),
  };
}

function accumulateUsage(target: ProcessMessageUsage, usage: ProcessMessageUsage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  target.totalTokens = (target.totalTokens ?? 0) + (usage.totalTokens ?? 0);
  target.costUsdTicks = (target.costUsdTicks ?? 0) + (usage.costUsdTicks ?? 0);
}

function hasUsage(usage: ProcessMessageUsage): boolean {
  return Boolean(
    (usage.inputTokens ?? 0) || (usage.outputTokens ?? 0) || (usage.totalTokens ?? 0) || (usage.costUsdTicks ?? 0),
  );
}

function getBatchFinishReason(finishReason: string | null | undefined): ProcessMessageFinishReason {
  switch (finishReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
      return finishReason;
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}

function toLocalToolCall(toolCall: BatchToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

function buildAssistantBatchMessage(content: string, toolCalls: ToolCall[]): ModelMessage | null {
  if (toolCalls.length === 0) {
    return content ? { role: "assistant", content } : null;
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (content) {
    parts.push({ type: "text", text: content });
  }
  for (const toolCall of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolArgumentsOrRaw(toolCall.function.arguments),
    });
  }
  return { role: "assistant", content: parts };
}

function buildToolBatchMessage(toolParts: ExecutedBatchTool[]): ModelMessage | null {
  if (toolParts.length === 0) {
    return null;
  }

  return {
    role: "tool",
    content: toolParts.map((part) => ({
      type: "tool-result" as const,
      toolCallId: part.toolCall.id,
      toolName: part.toolCall.function.name,
      output: part.toolResult.success
        ? ({ type: "json", value: toSerializableValue(part.toolResult) } as const)
        : ({ type: "error-json", value: toSerializableValue(part.toolResult) } as const),
    })),
  };
}

function parseToolArgumentsOrRaw(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

function toSerializableValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sumDefined(left?: number, right?: number): number | undefined {
  if (left == null && right == null) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function toToolCall(part: { toolCallId: string; toolName: string; args?: unknown; input?: unknown }): ToolCall {
  return {
    id: part.toolCallId,
    type: "function",
    function: {
      name: part.toolName,
      arguments: JSON.stringify(part.input ?? part.args ?? {}),
    },
  };
}

function notifyObserver<T>(listener: ((payload: T) => void) | undefined, payload: T): void {
  if (!listener) {
    return;
  }

  try {
    listener(payload);
  } catch {
    // Observer failures should never break generation.
  }
}

function getStepNumber(event: unknown, fallback: number): number {
  if (event && typeof event === "object" && "stepNumber" in event && typeof event.stepNumber === "number") {
    return event.stepNumber;
  }

  return fallback;
}

function getFinishReason(event: unknown): ProcessMessageFinishReason {
  if (event && typeof event === "object" && "finishReason" in event) {
    switch (event.finishReason) {
      case "stop":
      case "length":
      case "content-filter":
      case "tool-calls":
      case "error":
      case "other":
        return event.finishReason;
    }
  }

  return "other";
}

function getUsage(event: unknown): ProcessMessageUsage {
  if (!(event && typeof event === "object" && "usage" in event)) {
    return {};
  }

  const usage = event.usage;
  if (!usage || typeof usage !== "object") {
    return {};
  }

  const u = usage as Record<string, unknown>;
  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
    totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
  };
}

function toToolResult(output: unknown): ToolResult {
  if (output && typeof output === "object" && "success" in output) {
    const r = output as {
      success: boolean;
      output?: string;
      error?: string;
      diff?: ToolResult["diff"];
      plan?: Plan;
      task?: ToolResult["task"];
      delegation?: ToolResult["delegation"];
      backgroundProcess?: ToolResult["backgroundProcess"];
      media?: ToolResult["media"];
      computer?: ToolResult["computer"];
      lspDiagnostics?: ToolResult["lspDiagnostics"];
    };
    return {
      success: r.success,
      output: r.output,
      error: r.error ?? (r.success ? undefined : r.output),
      diff: r.diff,
      plan: r.plan,
      task: r.task,
      delegation: r.delegation,
      backgroundProcess: r.backgroundProcess,
      media: r.media,
      computer: r.computer,
      lspDiagnostics: r.lspDiagnostics,
    };
  }
  return { success: true, output: String(output) };
}

function formatSubagentActivity(toolName: string, args?: unknown): string {
  const parsed = parseToolArgs(args);
  if (toolName === "read_file") return `Read ${parsed.path || "file"}`;
  if (toolName === "lsp") return `LSP ${parsed.operation || "query"} ${parsed.filePath || ""}`.trim();
  if (toolName === "write_file") return `Write ${parsed.path || "file"}`;
  if (toolName === "edit_file") return `Edit ${parsed.path || "file"}`;
  if (toolName === "search_web") return `Web search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "search_x") return `X search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "generate_image") return `Generate image "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "generate_video") return `Generate video "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "computer_snapshot") return `Snapshot ${parsed.app || "desktop"}`;
  if (toolName === "computer_screenshot") return "Capture desktop screenshot";
  if (toolName === "computer_click")
    return parsed.ref ? `Click ${parsed.ref}` : `Click at ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_mouse_move")
    return parsed.ref ? `Hover ${parsed.ref}` : `Move mouse to ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_type") return `Type into ${parsed.ref || "element"}`;
  if (toolName === "computer_press") return `Press ${parsed.key || "key"}`;
  if (toolName === "computer_scroll") return `Scroll ${parsed.ref || "element"} ${parsed.direction || "down"}`;
  if (toolName === "computer_launch") return `Launch ${parsed.app || "app"}`;
  if (toolName === "computer_list_windows") return `List windows${parsed.app ? ` for ${parsed.app}` : ""}`;
  if (toolName === "computer_focus_window")
    return `Focus window ${parsed.window_id || parsed.title || parsed.app || ""}`.trim();
  if (toolName === "computer_wait") return "Wait for desktop state";
  if (toolName === "computer_get") return `Read ${parsed.property || "text"} from ${parsed.ref || "element"}`;
  if (toolName === "bash") return truncate(parsed.command || "Run command", 70);
  return truncate(`${toolName}`, 70);
}

function parseToolArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

function firstLine(text: string): string {
  return text.trim().split("\n").find(Boolean)?.trim() || "Task completed.";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatEntriesForRecap(entries: ChatEntry[], maxChars: number): string {
  const lines: string[] = [];
  let remaining = maxChars;

  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    const line = formatRecapEntry(entries[i]!);
    if (!line) {
      continue;
    }

    const bounded = truncate(line, Math.min(remaining, 520));
    if (!bounded.trim()) {
      continue;
    }

    lines.unshift(bounded);
    remaining -= bounded.length + 1;
  }

  return lines.join("\n");
}

function formatRecapEntry(entry: ChatEntry): string | null {
  const content = entry.content.trim();
  if (!content) {
    return null;
  }

  switch (entry.type) {
    case "user":
      return `[User] ${truncate(content, 420)}`;
    case "assistant":
      return `[Assistant] ${truncate(content, 420)}`;
    case "tool_result":
      return `[Tool ${entry.toolResult?.success === false ? "error" : "result"}] ${truncate(content, 260)}`;
    default:
      return null;
  }
}

function withAbortTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") {
    return signal;
  }
  return combineAbortSignals(signal, AbortSignal.timeout(timeoutMs));
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }

    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}

function isContextLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(context|token|prompt).*(limit|length|large|window|overflow)|too many tokens|maximum context/i.test(message);
}

function isAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api[_ ]?key|token|credential)|authentication failed|forbidden|access denied/i.test(
    message,
  );
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "The request was invalid. This may be caused by an unsupported parameter or model.",
  401: "Authentication failed. Your API key may be invalid or expired.",
  403: "Access denied. Your API key does not have permission for this request.",
  404: "The requested model or endpoint was not found. Check your model name and base URL.",
  408: "The request timed out. Please try again.",
  422: "The request could not be processed. Check your message format or parameters.",
  429: "Rate limit exceeded. Please wait a moment and try again.",
  500: "The API server encountered an internal error. Please try again later.",
  502: "The API server is temporarily unavailable. Please try again later.",
  503: "The API service is temporarily overloaded. Please try again later.",
  529: "The API service is overloaded. Please try again later.",
};

function humanizeApiError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const detail = extractResponseDetail(error.responseBody);
    if (detail) return detail;
    if (error.statusCode && STATUS_MESSAGES[error.statusCode]) {
      return STATUS_MESSAGES[error.statusCode];
    }
  }

  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^AI_\w+Error:\s*/i, "").trim() || raw;
}

function extractResponseDetail(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch {
    /* not JSON */
  }
  return null;
}
