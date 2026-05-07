/**
 * Intent detection and context-aware action compaction.
 *
 * Extracted from prompt-optimization.ts to keep files under ~500 LOC.
 * These helpers detect user intent from prompt content and strip
 * irrelevant action params to reduce context window usage.
 */

// ---------------------------------------------------------------------------
// Prompt compaction helpers
// ---------------------------------------------------------------------------

export function compactInitialCodeMarker(prompt: string): string {
  return prompt.replace(
    /initial code:\s*([0-9a-f]{8})[0-9a-f-]*/gi,
    "<initial_code>$1</initial_code>",
  );
}

// compactActionDocs removed — replaced by compactActionsForIntent which
// provides context-aware action formatting instead of blanket compaction.

export function compactRegistryCatalog(prompt: string): string {
  return prompt.replace(
    /\*\*Available Plugins from Registry \((\d+) total\):[\s\S]*?(?=\n## Project Context \(Workspace\)|\n### AGENTS\.md|$)/g,
    (_match, total: string) =>
      `**Available Plugins from Registry (${total} total):** [omitted in compact mode; query on demand]\n`,
  );
}

export function compactCodingActionExamples(prompt: string): string {
  const next = prompt.replace(
    /\n# (?:Coding|Task) Agent Action Call Examples[\s\S]*?(?=\nPossible response actions:|\n# Available Actions|\n## Project Context \(Workspace\)|$)/g,
    "\n",
  );
  return next.replace(/\nPossible response actions:[^\n]*\n?/g, "\n");
}

export function compactUiCatalog(prompt: string): string {
  return prompt.replace(
    /\n## Rich UI Output — you can render interactive components in your replies[\s\S]*?(?=\n## Project Context \(Workspace\)|\n### AGENTS\.md|$)/g,
    "\n",
  );
}

export function compactLoadedPluginLists(prompt: string): string {
  const loadedCountMatch = prompt.match(
    /\*\*Loaded Plugins:\*\*[\s\S]*?(?=\n\*\*System Plugins:\*\*)/,
  );
  const loadedCount = loadedCountMatch
    ? (loadedCountMatch[0].match(/\n- /g)?.length ?? 0)
    : 0;

  return prompt.replace(
    /\n\*\*Loaded Plugins:\*\*[\s\S]*?(?=\n\*\*Available Plugins from Registry|\nNo access to role information|\nSECURITY ALERT:|$)/g,
    `\n**Loaded Plugins:** ${loadedCount} loaded [list omitted in compact mode]`,
  );
}

export function compactEmoteCatalog(prompt: string): string {
  return prompt.replace(
    /\n## Available Emotes[\s\S]*?(?=\n# Active Workspaces & Agents|\n## Project Context \(Workspace\)|$)/g,
    "\n## Available Emotes\n[emote catalog omitted in compact mode]\n",
  );
}

export function compactWorkspaceContextForNonCoding(prompt: string): string {
  return prompt.replace(
    /\n## Project Context \(Workspace\)[\s\S]*?(?=\nAdmin trust:|\nThe current date and time is|\n# Conversation Messages|$)/g,
    "\n## Project Context (Workspace)\n[workspace file contents omitted in compact mode for non-coding intent]\n",
  );
}

export function compactUiComponentCatalog(prompt: string): string {
  return prompt.replace(
    /\n### Available components \((\d+) total\)[\s\S]*?(?=\n## Available Emotes|\n## Project Context \(Workspace\)|$)/g,
    (_match, total: string) =>
      `\n### Available components (${total} total)\n[component catalog omitted in compact mode]\n`,
  );
}

export function compactInstalledSkills(prompt: string): string {
  return prompt.replace(
    /\n## Installed Skills \((\d+)\)[\s\S]*?\*Use TOGGLE_SKILL to enable\/disable skills\.[\s\S]*?(?=\nMima is|\n\*\*Loaded Plugins:\*\*|\n## Project Context \(Workspace\)|$)/g,
    (_match, total: string) =>
      `\n## Installed Skills (${total})\n[skill list omitted in compact mode; query on demand]\n`,
  );
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

// Coding intent uses specific terms. Generic words like "fix", "build", "run"
// are excluded to avoid false positives ("fix the typo", "build me a haiku").
// Includes translations for supported locales: ko, zh-CN, es, pt, vi, tl.
const CODING_INTENT_RE =
  /\b(code|coding|codebase|repo|repository|pull request|pr\b|branch|merge|commit|deploy|refactor|research|investigate|analy[sz]e|analysis|draft|document|orchestrate|delegate|subtask|parallel|background task|task agent|start_coding_task|spawn_coding_agent|send_to_coding_agent|create_task|spawn_agent|send_to_agent|list_agents|stop_agent)\b|https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/|코드|코딩|레포|저장소|브랜치|커밋|배포|리팩토링|풀\s?리퀘스트|代码|仓库|分支|提交|部署|合并|拉取请求|\b(código|repositorio|repositório|confirmación|implementar|investigar|analizar|documentar)\b|mã|kho|nhánh|triển khai/i;
const PLUGIN_UI_INTENT_RE =
  /\b(plugin|plugins|configure|configuration|setup|install|enable|disable|api key|credential|secret|dashboard|form|ui|interface|\[config:)\b|플러그인|설정|설치|插件|配置|安装|\b(complemento|configurar|instalar|configuração)\b/i;
// Terminal intent requires specific CLI/tool terms, not generic verbs.
const TERMINAL_INTENT_RE =
  /\b(shell|command line|execute command|npm|bun|yarn|git\b|bash|terminal|script|pip|apt-get|brew)\b|터미널|명령어|스크립트|终端|命令行|脚本|\b(terminal|línea de comandos|linha de comando)\b/i;
const EMOTE_INTENT_RE =
  /\b(emote|wave|dance|bow|clap|laugh|angry|sad|think|sit|play_emote)\b|이모트|춤|인사|笑|跳舞|鞠躬|\b(bailar)\b/i;
// "close" and "label" removed — too generic ("close the file", "label this").
const ISSUE_INTENT_RE =
  /\b(issue|bug report|ticket|close issue|reopen issue|github issue|create issue|file a bug)\b|이슈|버그|티켓|问题|错误|工单|\b(problema|error|billete)\b/i;
// Wallet / on-chain intent should keep full action schemas to avoid "I will send"
// style larping when trade/transfer actions require detailed params.
const WALLET_INTENT_RE =
  /\b(wallet|onchain|on-chain|transaction|tx\b|transfer|swap|trade|send\b|gas|token|bnb|eth|sol|basechain|erc20|balance)\b|钱包|交易|转账|代币|余额|지갑|거래|전송|잔액|\b(cartera|transacci[oó]n|intercambio|saldo)\b/i;

/** Actions that are always included at full detail. */
export const UNIVERSAL_ACTIONS = new Set(["REPLY", "NONE", "IGNORE"]);

/**
 * Map intent categories → action names that get full params when detected.
 *
 * These names must match the registered action names in the runtime. If an
 * action is renamed or removed upstream, the compaction gracefully degrades
 * — the action simply won't appear in the prompt at all, so the stale name
 * in this map is harmless (it just won't match anything).
 */
export const INTENT_ACTION_MAP: Record<string, Set<string>> = {
  coding: new Set([
    "START_CODING_TASK",
    "CREATE_TASK",
    "SPAWN_AGENT",
    "PROVISION_WORKSPACE",
    "FINALIZE_WORKSPACE",
    "LIST_AGENTS",
    "SEND_TO_AGENT",
    "STOP_AGENT",
  ]),
  terminal: new Set(["SHELL_COMMAND", "RESTART_AGENT"]),
  issues: new Set(["MANAGE_ISSUES"]),
  emote: new Set(["PLAY_EMOTE"]),
  plugin_ui: new Set(["RESTART_AGENT"]),
  wallet: new Set(),
};

export function hasIntent(prompt: string, keywords: RegExp): boolean {
  const taskMatch = prompt.match(/<task>([\s\S]*?)<\/task>/i);
  const taskText = (taskMatch?.[1] ?? "").slice(0, 2000);
  if (keywords.test(taskText)) return true;

  // Extract just the user's message line(s) from "# Received Message".
  // The section also contains instructions with generic words like "execute",
  // "run", "command" — only match against the actual user text.
  const msgSection = prompt.indexOf("# Received Message");
  if (msgSection !== -1) {
    const afterHeader = prompt.slice(msgSection + "# Received Message".length);
    // User message is between the header and the next section marker (# or <)
    const nextSection = afterHeader.search(/\n#|\n<|\n\n\n/);
    const userMsg = (
      nextSection !== -1
        ? afterHeader.slice(0, nextSection)
        : afterHeader.slice(0, 500)
    ).trim();
    if (keywords.test(userMsg)) return true;
  }

  return false;
}

/**
 * Validate INTENT_ACTION_MAP against the runtime's registered actions.
 * Logs warnings for any mapped action names that don't exist in the runtime.
 * Call once at startup after plugins are loaded.
 */
export function validateIntentActionMap(
  registeredActions: string[],
  logger?: { warn: (msg: string) => void },
): void {
  const registered = new Set(registeredActions.map((a) => a.toUpperCase()));
  for (const [category, actions] of Object.entries(INTENT_ACTION_MAP)) {
    for (const action of actions) {
      if (!registered.has(action)) {
        logger?.warn(
          `[eliza] INTENT_ACTION_MAP["${category}"] references "${action}" which is not a registered action — may be renamed or removed upstream`,
        );
      }
    }
  }
}

/**
 * Detect which intent categories are present in the prompt.
 * Returns array of category names (e.g. ["coding", "terminal"]).
 * Multiple categories can match simultaneously.
 */
export function detectIntentCategories(prompt: string): string[] {
  const categories: string[] = [];
  if (hasIntent(prompt, CODING_INTENT_RE)) categories.push("coding");
  if (hasIntent(prompt, TERMINAL_INTENT_RE)) categories.push("terminal");
  if (hasIntent(prompt, ISSUE_INTENT_RE)) categories.push("issues");
  if (hasIntent(prompt, EMOTE_INTENT_RE)) categories.push("emote");
  if (hasIntent(prompt, PLUGIN_UI_INTENT_RE)) categories.push("plugin_ui");
  if (hasIntent(prompt, WALLET_INTENT_RE)) categories.push("wallet");
  return categories;
}

/**
 * Build the set of action names that should get full param detail.
 * Universal actions are always included. Intent-matched actions are
 * added based on detected categories. Everything else gets stub-only.
 */
export function buildFullParamActionSet(
  intentCategories: string[],
): Set<string> {
  const fullActions = new Set(UNIVERSAL_ACTIONS);
  for (const cat of intentCategories) {
    const actions = INTENT_ACTION_MAP[cat];
    if (actions) {
      for (const a of actions) fullActions.add(a);
    }
  }
  // Coding intent also implies terminal + issues
  if (intentCategories.includes("coding")) {
    for (const a of INTENT_ACTION_MAP.terminal) fullActions.add(a);
    for (const a of INTENT_ACTION_MAP.issues) fullActions.add(a);
  }
  return fullActions;
}

/**
 * Strip internal thoughts, action lists, and entity UUIDs from conversation
 * history when no coding/swarm intent is detected. For general chat, the
 * agent's previous reasoning and action selections are noise — only the
 * actual messages matter. Coding tasks keep the full context so the swarm
 * coordinator can see its previous reasoning chain.
 *
 * Targets lines like:
 *   (Eliza's internal thought: User wants me to spawn...)
 *   (Eliza's actions: REPLY, START_CODING_TASK)
 *   12:53 (17 minutes ago) [b850bc30-45f8-0041-a00a-83df46d8555d]
 *                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ UUID
 */
export function compactConversationHistory(prompt: string): string {
  if (hasIntent(prompt, CODING_INTENT_RE)) return prompt;
  // Wallet/on-chain turns need full history for transaction context
  if (hasIntent(prompt, WALLET_INTENT_RE)) return prompt;

  const msgStart = prompt.indexOf("# Conversation Messages");
  if (msgStart === -1) return prompt;
  const msgEnd = prompt.indexOf("\n# Received Message", msgStart);
  if (msgEnd === -1) return prompt;

  const before = prompt.slice(0, msgStart);
  const history = prompt.slice(msgStart, msgEnd);
  const after = prompt.slice(msgEnd);

  const compacted = history
    // Strip internal thought lines (single-line only — [^\n]* prevents
    // eating across lines if the thought contains unbalanced parens)
    .replace(/\n\([^\n]*'s internal thought:[^\n]*\)/g, "")
    // Strip action list lines
    .replace(/\n\s*\([^)]*'s actions:.*?\)/g, "")
    // Strip entity UUIDs from timestamps: [b850bc30-45f8-...] → ""
    .replace(
      /\s*\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/g,
      "",
    )
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, "\n\n");

  return before + compacted + after;
}

/**
 * Strip the task-agent examples provider section when no task/coding intent
 * is detected. These examples teach the LLM how to use START_CODING_TASK /
 * SPAWN_AGENT / FINALIZE_WORKSPACE and related aliases, which are unnecessary
 * for general chat, emote, or plugin-config messages.
 */
export function compactCodingExamplesForIntent(prompt: string): string {
  if (hasIntent(prompt, CODING_INTENT_RE)) return prompt;
  // Guard: if the boundary header is missing, don't strip — the regex would
  // match to end-of-string and remove everything after the examples header.
  if (!prompt.includes("# Available Actions")) return prompt;
  // Strip everything from the examples header up to (but not including)
  // the "# Available Actions" header. Match the markdown header specifically
  // so example bodies cannot affect the boundary.
  return prompt.replace(
    /# (?:Coding|Task) Agent Action Call Examples[\s\S]*?(?=\n# Available Actions)/,
    "",
  );
}

/**
 * Context-aware action formatting. Replaces the available-actions block in
 * the prompt with a version where only intent-relevant actions keep full
 * parameter detail — the rest are stubs with just name + description.
 *
 * Supports the legacy line-oriented prompt encoding emitted by older actions providers:
 *   actions[N]:
 *   - ACTION: description
 *     aliases[..]: ...
 *     tags[..]: ...
 *     params[..]: ...
 *     example: ...
 *
 * If no intents are detected (general chat), only universal actions
 * (REPLY, NONE, IGNORE) keep full params — all others are stubbed.
 */
export function compactActionsForIntent(prompt: string): string {
  // Wallet / on-chain tasks need full action param schemas for reliable tool
  // invocation across providers and languages. Skip action compaction here.
  if (hasIntent(prompt, WALLET_INTENT_RE)) {
    return prompt;
  }

  // NOTE: Intent detection is English-keyword-based. Non-English messages may
  // not trigger any intent, causing all non-universal action params to be
  // stripped. This is a graceful degradation — action names and descriptions
  // are always preserved, so the LLM can still select the right action; it
  // just won't see detailed param schemas until the user triggers a known intent.

  const intentCategories = detectIntentCategories(prompt);
  // When no specific intent is detected, it's general chat — only universal
  // actions (REPLY, NONE, IGNORE) need full detail. All other actions get
  // stubs so the LLM knows they exist but doesn't waste context on params.
  const fullParamActions = buildFullParamActionSet(intentCategories);

  return compactStructuredActionsBlock(prompt, fullParamActions) ?? prompt;
}

/**
 * Locate and compact a structured "Available Actions" block.
 */
function compactStructuredActionsBlock(
  prompt: string,
  fullParamActions: Set<string>,
): string | null {
  // The actions provider emits "actions[N]:\n- NAME: desc\n  params[..]: ...".
  // Anchor on that header line.
  const headerRe = /^actions\[\d+\]:[ \t]*$/m;
  const headerMatch = headerRe.exec(prompt);
  if (!headerMatch) return null;

  const blockStart = headerMatch.index;
  const headerLine = headerMatch[0];
  const bodyStart = blockStart + headerLine.length;

  // Walk forward consuming action entries (`- NAME: ...`) and their
  // two-space-indented continuation lines. Stop at the first non-indented
  // non-entry line that isn't part of an entry.
  const remainder = prompt.slice(bodyStart);
  const lines = remainder.split("\n");

  let consumed = 0;
  if (lines.length > 0 && lines[0] === "") {
    consumed = 1;
  }

  while (consumed < lines.length) {
    const line = lines[consumed];
    if (line.startsWith("- ") || line.startsWith("  ")) {
      consumed += 1;
      continue;
    }
    if (line === "") {
      const next = lines[consumed + 1];
      if (next?.startsWith("- ")) {
        consumed += 1;
        continue;
      }
      break;
    }
    break;
  }

  const bodyLines = lines.slice(0, consumed);
  const blockEnd = bodyStart + bodyLines.join("\n").length;

  type JsonAction = { name: string; entryLines: string[] };
  const entries: JsonAction[] = [];
  let current: JsonAction | null = null;
  for (const line of bodyLines) {
    if (line.startsWith("- ")) {
      if (current) entries.push(current);
      const nameMatch = /^- ([A-Z0-9_]+):/.exec(line);
      const name = nameMatch?.[1] ?? "";
      current = { name, entryLines: [line] };
    } else if (current && (line.startsWith("  ") || line === "")) {
      current.entryLines.push(line);
    }
  }
  if (current) entries.push(current);

  if (entries.length === 0) return null;

  const compactedEntries = entries.map((entry) => {
    if (!entry.name || fullParamActions.has(entry.name)) {
      return entry.entryLines.join("\n");
    }
    // Stub: keep only `- NAME: description`; drop continuation lines.
    return entry.entryLines[0];
  });

  while (
    compactedEntries.length > 0 &&
    compactedEntries[compactedEntries.length - 1] === ""
  ) {
    compactedEntries.pop();
  }

  const compactedBody = compactedEntries.join("\n");
  const before = prompt.slice(0, bodyStart);
  const after = prompt.slice(blockEnd);
  const separator = bodyLines.length > 0 && bodyLines[0] === "" ? "\n" : "";
  return `${before}${separator}${compactedBody}${after}`;
}

export function compactModelPrompt(prompt: string): string {
  const hasCodingIntent = hasIntent(prompt, CODING_INTENT_RE);
  const hasPluginUiIntent = hasIntent(prompt, PLUGIN_UI_INTENT_RE);

  let next = prompt;
  next = compactInitialCodeMarker(next);
  if (!hasCodingIntent) {
    next = compactCodingActionExamples(next);
  }
  // Action compaction is handled by installPromptOptimizations before
  // compactModelPrompt is called — no need to run it again here.
  next = compactLoadedPluginLists(next);
  next = compactEmoteCatalog(next);
  if (!hasCodingIntent) {
    next = compactInstalledSkills(next);
  }
  if (!hasPluginUiIntent) {
    next = compactRegistryCatalog(next);
    next = compactUiCatalog(next);
  } else {
    next = compactUiComponentCatalog(next);
  }
  if (!hasCodingIntent) {
    next = compactWorkspaceContextForNonCoding(next);
  }
  return next;
}
