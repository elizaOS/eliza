/**
 * Slash-command menu — the pure, surface-agnostic core of the chat composer's
 * inline command autocomplete.
 *
 * Everything here is a pure function so it can be unit-tested without React or
 * the DOM. The catalog item shape mirrors the server's `SerializedCommand`
 * (@elizaos/plugin-commands) served from `GET /api/commands`; the client keeps
 * its own copy of the type rather than depending on the runtime package.
 */

import {
  matchShortcut,
  type ShortcutDefinition,
  type ShortcutPattern,
  type ShortcutTarget,
} from "@elizaos/core";
import type {
  ClientCommandAction,
  CommandArgSource,
  CommandSurface,
  SlashCommandCatalogItem,
} from "../api/client-types-commands";

export type {
  ClientCommandAction,
  CommandArgSource,
  CommandSurface,
  SlashCommandArg,
  SlashCommandCatalogItem,
  SlashCommandSource,
  SlashCommandTarget,
} from "../api/client-types-commands";

// ── Parsing ────────────────────────────────────────────────────────────────

export interface ParsedSlashDraft {
  /** True when the draft is a single-line slash input (`/...`, no newline). */
  isSlash: boolean;
  /** The full trimmed-left draft. */
  raw: string;
  /** The command token typed after the leading slash, lowercased (no slash). */
  commandToken: string;
  /** True once a space follows the command token (i.e. we're typing args). */
  hasSpace: boolean;
  /** Argument tokens after the command alias. */
  argTokens: string[];
  /** The last (currently-typed) argument token. */
  argQuery: string;
}

const NONE: ParsedSlashDraft = {
  isSlash: false,
  raw: "",
  commandToken: "",
  hasSpace: false,
  argTokens: [],
  argQuery: "",
};

/**
 * Parse a composer draft into slash-menu state. Only triggers for a draft that
 * starts with `/` (after leading whitespace) and contains no newline — a
 * multiline draft is prose, not a command.
 */
export function parseSlashDraft(draft: string): ParsedSlashDraft {
  if (!draft) return NONE;
  // Leading whitespace is allowed but a newline means it's a message, not a command.
  if (draft.includes("\n")) return NONE;
  const raw = draft.replace(/^\s+/, "");
  if (!raw.startsWith("/")) return NONE;

  const body = raw.slice(1);
  const firstSpace = body.indexOf(" ");
  if (firstSpace === -1) {
    return {
      isSlash: true,
      raw,
      commandToken: body.toLowerCase(),
      hasSpace: false,
      argTokens: [],
      argQuery: body.toLowerCase(),
    };
  }

  const commandToken = body.slice(0, firstSpace).toLowerCase();
  const argsPart = body.slice(firstSpace + 1);
  const argTokens = argsPart.length ? argsPart.split(/\s+/) : [];
  // When the draft ends with a space, the user has "committed" the last token
  // and is starting a fresh (empty) one.
  const endsWithSpace = /\s$/.test(argsPart);
  const argQuery = endsWithSpace ? "" : (argTokens[argTokens.length - 1] ?? "");
  return {
    isSlash: true,
    raw,
    commandToken,
    hasSpace: true,
    argTokens,
    argQuery,
  };
}

/**
 * Split a sent message that begins with a slash-command token into the command
 * and the trailing remainder, so the chat bubble can render `/command` in bold.
 * Returns `null` unless the text starts with a `/word` token bounded by
 * whitespace or end-of-string — so `/imagine a cat` and `/settings` split, but
 * a path like `/usr/bin` (no boundary after the first segment) does not.
 */
export function splitLeadingSlashCommand(
  text: string,
): { command: string; rest: string } | null {
  const match = /^(\/[\w-]+)(?=\s|$)/.exec(text);
  if (!match) return null;
  const command = match[1];
  return { command, rest: text.slice(command.length) };
}

// ── Surface + authorization gating ───────────────────────────────────────────

export interface SurfaceAuthContext {
  /** The surface the menu is rendered on (e.g. "gui"). */
  surface: CommandSurface;
  /** Whether the current sender is authenticated. Defaults to true at callsites. */
  isAuthorized: boolean;
  /** Whether the current sender has elevated/owner privileges. */
  isElevated: boolean;
}

/**
 * Gate the raw catalog to the commands a given sender may see on a given
 * surface. Pure so it can be unit-tested without React. Applied once, where the
 * controller exposes its merged `commands`, so surface + auth gating flows
 * uniformly through matching, listing, and resolution.
 *
 * Rules:
 * - A command with a non-empty `surfaces` list is hidden unless that list
 *   includes the current surface. An undefined/empty `surfaces` means the
 *   command is surface-agnostic and shown everywhere (default).
 * - `requiresAuth` commands are hidden when the sender is not authorized.
 * - `requiresElevated` commands are hidden when the sender is not elevated.
 */
export function filterCommandsForSurface(
  commands: SlashCommandCatalogItem[],
  { surface, isAuthorized, isElevated }: SurfaceAuthContext,
): SlashCommandCatalogItem[] {
  return commands.filter((command) => {
    if (command.surfaces?.length && !command.surfaces.includes(surface)) {
      return false;
    }
    if (command.requiresAuth && !isAuthorized) return false;
    if (command.requiresElevated && !isElevated) return false;
    return true;
  });
}

// ── Matching + filtering ─────────────────────────────────────────────────────

function aliasMatches(
  command: SlashCommandCatalogItem,
  token: string,
): boolean {
  const normalized = `/${token}`.toLowerCase();
  return command.textAliases.some((a) => a.toLowerCase() === normalized);
}

/** Exact-match the command token against an alias (used once a space is typed). */
export function matchCommand(
  commands: SlashCommandCatalogItem[],
  commandToken: string,
): SlashCommandCatalogItem | undefined {
  return commands.find((c) => aliasMatches(c, commandToken));
}

/** Score a command against a query for ranking (lower = better, -1 = no match). */
function scoreCommand(command: SlashCommandCatalogItem, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  let best = -1;
  const consider = (haystack: string, weight: number) => {
    const h = haystack.toLowerCase();
    if (h === q) {
      best = best === -1 ? weight : Math.min(best, weight);
    } else if (h.startsWith(q)) {
      const s = weight + 1;
      best = best === -1 ? s : Math.min(best, s);
    } else if (h.includes(q)) {
      const s = weight + 2;
      best = best === -1 ? s : Math.min(best, s);
    }
  };
  // Aliases (without slash) rank highest, then native name, then description.
  for (const alias of command.textAliases)
    consider(alias.replace(/^\//, ""), 0);
  consider(command.nativeName, 3);
  consider(command.key, 3);
  consider(command.description, 6);
  return best;
}

/**
 * Filter + rank commands for the "command" mode of the menu (before a space).
 * An empty query returns the whole list in catalog order.
 */
export function filterCommands(
  commands: SlashCommandCatalogItem[],
  query: string,
): SlashCommandCatalogItem[] {
  if (!query) return [...commands];
  const scored = commands
    .map((command, index) => ({
      command,
      index,
      score: scoreCommand(command, query),
    }))
    .filter((entry) => entry.score >= 0);
  scored.sort((a, b) =>
    a.score === b.score ? a.index - b.index : a.score - b.score,
  );
  return scored.map((entry) => entry.command);
}

/**
 * Index of the argument currently being completed, given the typed arg tokens
 * and whether the draft ends with a space (a trailing space advances to the
 * next, not-yet-typed, argument).
 */
export function activeArgIndex(
  command: SlashCommandCatalogItem,
  draft: ParsedSlashDraft,
): number {
  if (!command.acceptsArgs || command.args.length === 0) return -1;
  if (!draft.hasSpace) return -1;
  const typed = draft.argTokens.length;
  const endsWithSpace = draft.argQuery === "" && typed > 0;
  const idx = endsWithSpace ? typed : Math.max(0, typed - 1);
  return Math.min(idx, command.args.length - 1);
}

/** Filter a set of resolved arg choices by the partial token being typed. */
export function filterArgChoices(choices: string[], query: string): string[] {
  if (!query) return [...choices];
  const q = query.toLowerCase();
  const starts = choices.filter((c) => c.toLowerCase().startsWith(q));
  const includes = choices.filter(
    (c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q),
  );
  return [...starts, ...includes];
}

// ── Natural client shortcuts ────────────────────────────────────────────────

const NAVIGATION_VERB_PATTERN =
  "(?:open|show(?:\\s+me)?|go\\s+to|switch\\s+to|take\\s+me\\s+to|pull\\s+up|bring\\s+up)";
const OPTIONAL_OBJECT_PATTERN = "(?:(?:the|my)\\s+)?";
const SLOT_WORD_PATTERN = "[\\p{L}\\p{N}]+(?:\\s+[\\p{L}\\p{N}]+)*";
const SLOT_WORD_PATTERN_LAZY = "[\\p{L}\\p{N}]+(?:\\s+[\\p{L}\\p{N}]+)*?";

export interface ResolveClientShortcutOptions {
  allowNatural?: boolean;
  isAuthorized?: boolean;
  isElevated?: boolean;
  resolveChoices?: (source: CommandArgSource) => string[];
}

function normalizeShortcutPhrase(value: string | undefined): string {
  return (value ?? "")
    .replace(/^\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function phraseRegexSource(phrase: string): string {
  return normalizeShortcutPhrase(phrase)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

function regexPattern(source: string, confidence: number): ShortcutPattern {
  return { regex: new RegExp(source, "iu"), confidence };
}

function primaryAlias(command: SlashCommandCatalogItem): string {
  return command.textAliases[0] ?? `/${command.nativeName}`;
}

function commandPhrases(command: SlashCommandCatalogItem): string[] {
  const phrases = new Map<string, string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeShortcutPhrase(value);
    if (!normalized || phrases.has(normalized)) return;
    phrases.set(normalized, normalized);
  };

  for (const alias of command.textAliases) add(alias);
  add(command.nativeName);
  add(command.key);
  if (command.target.kind === "navigate") {
    add(command.target.tab);
    add(command.target.viewId);
    if (command.target.section) add(`${command.target.section} settings`);
  }
  return [...phrases.values()];
}

function shortcutTargetForCommand(
  command: SlashCommandCatalogItem,
): ShortcutTarget {
  if (command.target.kind === "client") {
    return { kind: "client", clientAction: command.target.clientAction };
  }
  if (command.target.kind === "navigate") {
    return {
      kind: "navigate",
      path: command.target.path ?? "",
      tab: command.target.tab,
      viewId: command.target.viewId,
      section: command.target.section,
    };
  }
  return { kind: "client", clientAction: command.key };
}

function naturalPatternsForCommand(
  command: SlashCommandCatalogItem,
): ShortcutPattern[] {
  const target = command.target;
  if (target.kind === "agent") return [];

  if (target.kind === "client") {
    switch (target.clientAction) {
      case "clear-chat":
        return [
          regexPattern(
            "^(?:clear|reset)\\s+(?:the\\s+|current\\s+)?(?:chat|conversation|thread)$",
            0.95,
          ),
        ];
      case "new-conversation":
        return [
          regexPattern(
            "^(?:new|start|open)\\s+(?:a\\s+)?(?:chat|conversation|thread)$",
            0.92,
          ),
        ];
      case "toggle-fullscreen":
        return [
          regexPattern(
            "^(?:toggle|enter|exit|open|close)\\s+(?:full\\s+screen|fullscreen)(?:\\s+chat)?$",
            0.9,
          ),
          regexPattern("^(?:full\\s+screen|fullscreen)\\s+chat$", 0.86),
        ];
      case "open-command-palette":
      case "show-commands":
        return [
          regexPattern(
            `^${NAVIGATION_VERB_PATTERN}\\s+(?:the\\s+)?(?:command\\s+palette|commands)$`,
            0.9,
          ),
          regexPattern("^(?:show|list)\\s+(?:available\\s+)?commands$", 0.9),
        ];
      case "toggle-transcription":
        return [
          regexPattern(
            "^(?:toggle|start|stop|turn\\s+on|turn\\s+off)\\s+(?:transcription|transcribe|dictation)$",
            0.9,
          ),
          regexPattern("^(?:transcribe|dictate)$", 0.84),
        ];
    }
  }

  const patterns: ShortcutPattern[] = [];
  const phrases = commandPhrases(command)
    .map(phraseRegexSource)
    .filter(Boolean);
  if (phrases.length > 0) {
    patterns.push(
      regexPattern(
        `^${NAVIGATION_VERB_PATTERN}\\s+${OPTIONAL_OBJECT_PATTERN}(?:${phrases.join("|")})$`,
        0.94,
      ),
    );
  }

  if (target.kind === "navigate" && target.tab === "settings") {
    patterns.push(
      regexPattern(
        `^${NAVIGATION_VERB_PATTERN}\\s+${OPTIONAL_OBJECT_PATTERN}(?<section>${SLOT_WORD_PATTERN})\\s+settings$`,
        0.91,
      ),
      regexPattern(
        `^(?:change|configure|edit|set)\\s+${OPTIONAL_OBJECT_PATTERN}(?<section>${SLOT_WORD_PATTERN})\\s+settings$`,
        0.88,
      ),
    );
  }

  if (target.kind === "navigate" && commandHasArgSource(command, "views")) {
    patterns.push(
      regexPattern(
        `^${NAVIGATION_VERB_PATTERN}\\s+${OPTIONAL_OBJECT_PATTERN}(?<view>${SLOT_WORD_PATTERN_LAZY})\\s+(?:view|app|screen)$`,
        0.75,
      ),
      regexPattern(
        `^${NAVIGATION_VERB_PATTERN}\\s+${OPTIONAL_OBJECT_PATTERN}(?<view>${SLOT_WORD_PATTERN})$`,
        0.72,
      ),
    );
  }

  return patterns;
}

function naturalShortcutDefinitions(commands: SlashCommandCatalogItem[]): {
  definitions: ShortcutDefinition[];
  commandById: Map<string, SlashCommandCatalogItem>;
} {
  const commandById = new Map<string, SlashCommandCatalogItem>();
  const definitions: ShortcutDefinition[] = [];

  for (const command of commands) {
    if (command.target.kind === "agent") continue;
    const patterns = naturalPatternsForCommand(command);
    if (patterns.length === 0) continue;
    const id = `client-command:${command.key}`;
    commandById.set(id, command);
    definitions.push({
      id,
      kind: "natural",
      patterns,
      target: shortcutTargetForCommand(command),
      confidence: 0.9,
      priority: command.target.kind === "navigate" ? 20 : 10,
      requiresAuth: command.requiresAuth,
      requiresElevated: command.requiresElevated,
    });
  }

  return { definitions, commandById };
}

function cleanSlotValue(value: string | undefined): string {
  return normalizeShortcutPhrase(value)
    .replace(/^(?:the|my)\s+/, "")
    .replace(/\s+(?:view|app|screen)$/, "")
    .trim();
}

function resolveChoice(
  value: string | undefined,
  choices: readonly string[],
): string | undefined {
  const normalized = cleanSlotValue(value);
  if (!normalized || choices.length === 0) return undefined;
  return choices.find(
    (choice) => normalizeShortcutPhrase(choice) === normalized,
  );
}

function resolveSectionSlot(
  value: string | undefined,
  resolveSection: (token: string) => string | undefined,
): string | undefined {
  const normalized = cleanSlotValue(value);
  if (!normalized) return undefined;
  return (
    resolveSection(normalized) ??
    resolveSection(normalized.replace(/\s+/g, "-"))
  );
}

/**
 * Resolve caller-enabled natural-language client shortcuts (e.g. "open settings",
 * "show me my calendar", "clear chat") into the same execution objects as
 * slash commands. Agent-targeted commands deliberately fall through to normal
 * chat; only deterministic navigate/client commands are eligible here.
 */
export function resolveClientShortcutExecution(
  commands: SlashCommandCatalogItem[],
  text: string,
  resolveSection: (token: string) => string | undefined = (t) => t,
  options: ResolveClientShortcutOptions = {},
): SlashExecution | null {
  if (!options.allowNatural) return null;
  const raw = text.trim();
  if (
    !raw ||
    raw.startsWith("/") ||
    raw.startsWith("!") ||
    raw.includes("\n")
  ) {
    return null;
  }

  const { definitions, commandById } = naturalShortcutDefinitions(commands);
  const match = matchShortcut(definitions, raw, {
    allowNatural: true,
    // Fail-closed (#12087 Item 20): a caller that omits the sender's authority
    // must not resolve `requiresAuth`/`requiresElevated` natural-language
    // shortcuts. The controller threads the real tier via `slash.isAuthorized`
    // / `slash.isElevated`.
    isAuthorized: options.isAuthorized ?? false,
    isElevated: options.isElevated ?? false,
  });
  if (!match) return null;

  const command = commandById.get(match.shortcut.id);
  if (!command) return null;

  const alias = primaryAlias(command);
  if (match.parameters.section) {
    const section = resolveSectionSlot(
      match.parameters.section,
      resolveSection,
    );
    if (!section) return null;
    return resolveSlashExecution(
      command,
      `${alias} ${section}`,
      resolveSection,
    );
  }

  if (match.parameters.view) {
    const view = resolveChoice(
      match.parameters.view,
      options.resolveChoices?.("views") ?? [],
    );
    if (!view) return null;
    return resolveSlashExecution(command, `${alias} ${view}`, resolveSection);
  }

  return resolveSlashExecution(command, alias, resolveSection);
}

// ── Completion (Tab) ─────────────────────────────────────────────────────────

/** The draft text after completing to a command alias (with trailing space if it takes args). */
export function completeCommand(command: SlashCommandCatalogItem): string {
  const alias = command.textAliases[0] ?? `/${command.nativeName}`;
  return command.acceptsArgs && command.args.length > 0 ? `${alias} ` : alias;
}

/** The draft text after completing the active arg to `choice`. */
export function completeArg(draft: ParsedSlashDraft, choice: string): string {
  const tokens = [...draft.argTokens];
  const endsWithSpace = draft.argQuery === "" && tokens.length > 0;
  if (endsWithSpace) {
    tokens.push(choice);
  } else if (tokens.length === 0) {
    tokens.push(choice);
  } else {
    tokens[tokens.length - 1] = choice;
  }
  // Reconstruct: `/<alias> <tokens...>` using the alias the user actually typed.
  return `/${draft.commandToken} ${tokens.join(" ")}`;
}

// ── Execution ────────────────────────────────────────────────────────────────

export type SlashExecution =
  | { kind: "navigate-tab"; tab: string }
  | { kind: "navigate-settings"; section?: string }
  | { kind: "navigate-view"; viewId?: string; viewPath?: string }
  | { kind: "client"; clientAction: ClientCommandAction }
  | { kind: "send"; text: string };

/**
 * Resolve what running a command should do, given the raw draft text. Pure —
 * the side effects are performed by {@link runSlashExecution}.
 *
 * `resolveSection` maps a user-typed settings token (e.g. "model") to a
 * canonical section id (e.g. "ai-model"); supplied by the caller because that
 * mapping is UI knowledge.
 */
export function resolveSlashExecution(
  command: SlashCommandCatalogItem,
  rawText: string,
  resolveSection: (token: string) => string | undefined = (t) => t,
): SlashExecution {
  const target = command.target;
  if (target.kind === "client") {
    return { kind: "client", clientAction: target.clientAction };
  }
  if (target.kind === "navigate") {
    const draft = parseSlashDraft(rawText);
    const firstArg = draft.argTokens[0];
    // Settings: optional section sub-argument.
    if (target.tab === "settings") {
      const section = firstArg ? resolveSection(firstArg) : target.section;
      return section
        ? { kind: "navigate-settings", section }
        : { kind: "navigate-settings" };
    }
    // A specific view id (e.g. orchestrator), or `/views <id>`.
    if (target.viewId) {
      return {
        kind: "navigate-view",
        viewId: target.viewId,
        viewPath: target.path,
      };
    }
    if (firstArg && commandHasArgSource(command, "views")) {
      return { kind: "navigate-view", viewId: firstArg };
    }
    if (target.tab) {
      return { kind: "navigate-tab", tab: target.tab };
    }
    if (target.path) {
      return { kind: "navigate-view", viewPath: target.path };
    }
  }
  // Agent target (or anything unrecognized): send the literal slash text.
  return { kind: "send", text: rawText.trim() };
}

function commandHasArgSource(
  command: SlashCommandCatalogItem,
  source: CommandArgSource,
): boolean {
  return command.args.some((a) => a.dynamicChoices === source);
}

export interface SlashExecutionDeps {
  navigateTab: (tab: string) => void;
  navigateSettings: (section?: string) => void;
  navigateView: (target: { viewId?: string; viewPath?: string }) => void;
  clearChat: () => void;
  newConversation: () => void;
  toggleFullscreen: () => void;
  openCommandPalette: () => void;
  showCommands: () => void;
  toggleTranscription: () => void;
  send: (text: string) => void;
}

/** Perform a resolved execution by dispatching to injected side-effect deps. */
export function runSlashExecution(
  exec: SlashExecution,
  deps: SlashExecutionDeps,
): void {
  switch (exec.kind) {
    case "navigate-tab":
      deps.navigateTab(exec.tab);
      return;
    case "navigate-settings":
      deps.navigateSettings(exec.section);
      return;
    case "navigate-view":
      deps.navigateView({ viewId: exec.viewId, viewPath: exec.viewPath });
      return;
    case "client":
      switch (exec.clientAction) {
        case "clear-chat":
          deps.clearChat();
          return;
        case "new-conversation":
          deps.newConversation();
          return;
        case "toggle-fullscreen":
          deps.toggleFullscreen();
          return;
        case "open-command-palette":
          deps.openCommandPalette();
          return;
        case "show-commands":
          deps.showCommands();
          return;
        case "toggle-transcription":
          deps.toggleTranscription();
          return;
      }
      return;
    case "send":
      deps.send(exec.text);
      return;
  }
}
