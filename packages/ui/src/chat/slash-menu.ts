/**
 * Slash-command menu — the pure, surface-agnostic core of the chat composer's
 * inline command autocomplete.
 *
 * Everything here is a pure function so it can be unit-tested without React or
 * the DOM. The catalog item shape mirrors the server's `SerializedCommand`
 * (@elizaos/plugin-commands) served from `GET /api/commands`; the client keeps
 * its own copy of the type rather than depending on the runtime package.
 */

import type {
  ClientCommandAction,
  CommandArgSource,
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
      }
      return;
    case "send":
      deps.send(exec.text);
      return;
  }
}
