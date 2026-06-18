/**
 * Pure helpers that bridge the universal slash-command catalog (served by
 * `GET /api/commands?surface=tui`) into the terminal composer.
 *
 * The catalog item shape mirrors the server's `SerializedCommand`
 * (@elizaos/plugin-commands). We keep a local copy of the transport type so
 * the TUI does not take a runtime dependency on the commands plugin, matching
 * how the web client (`@elizaos/ui` `client-types-commands`) keeps its own.
 *
 * Everything here is pure (no terminal, no I/O) so it is unit-testable. The
 * side effects (HTTP, transcript mutation) live in `agent-terminal-tui.ts`.
 */

import type { AutocompleteItem, SlashCommand } from "@elizaos/tui";

export type CommandSurface = "gui" | "tui" | "discord" | "telegram";

export type CommandArgSource =
  | "models"
  | "views"
  | "settings-sections"
  | "skills"
  | "providers";

export type ClientCommandAction =
  | "clear-chat"
  | "new-conversation"
  | "toggle-fullscreen"
  | "open-command-palette"
  | "show-commands";

export interface SerializedCommandArg {
  name: string;
  description: string;
  required?: boolean;
  choices?: string[];
  dynamicChoices?: CommandArgSource;
  captureRemaining?: boolean;
}

export type SerializedCommandTarget =
  | { kind: "agent"; action?: string }
  | {
      kind: "navigate";
      tab?: string;
      viewId?: string;
      path?: string;
      section?: string;
    }
  | { kind: "client"; clientAction: ClientCommandAction };

export interface SerializedCommand {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  scope: "text" | "native" | "both";
  category?: string;
  acceptsArgs: boolean;
  args: SerializedCommandArg[];
  requiresAuth: boolean;
  requiresElevated: boolean;
  surfaces?: CommandSurface[];
  target: SerializedCommandTarget;
  icon?: string;
}

export interface CommandsCatalogResponse {
  commands: SerializedCommand[];
  surface: string | null;
  agentId: string | null;
  generatedAt: string;
}

/**
 * The display name for a command (no leading slash). Prefers the first text
 * alias the user actually types (e.g. `/help` → `help`) and falls back to the
 * native name. This is what the autocomplete dropdown shows and what the
 * Editor inserts as `/<name> `.
 */
export function commandName(command: SerializedCommand): string {
  const firstAlias = command.textAliases[0];
  if (firstAlias) return firstAlias.replace(/^\//, "");
  return command.nativeName;
}

/**
 * Map a serialized catalog command to the tui `SlashCommand` the
 * `CombinedAutocompleteProvider` expects. Argument completions are wired only
 * when the command exposes a single first argument with static `choices`
 * (the autocomplete provider has no live-source resolution, so dynamic-only
 * args contribute no suggestions).
 */
export function toSlashCommand(command: SerializedCommand): SlashCommand {
  const name = commandName(command);
  const slash: SlashCommand = {
    name,
    description: command.description,
  };

  const firstArg = command.args[0];
  const choices = firstArg?.choices;
  if (choices && choices.length > 0) {
    slash.getArgumentCompletions = (
      argumentPrefix: string,
    ): AutocompleteItem[] | null => {
      const query = argumentPrefix.trim().toLowerCase();
      const matched = query
        ? choices.filter((choice) => choice.toLowerCase().includes(query))
        : choices;
      if (matched.length === 0) return null;
      return matched.map((choice) => ({ value: choice, label: choice }));
    };
  }

  return slash;
}

/** Map the whole catalog to tui slash commands, preserving catalog order. */
export function toSlashCommands(commands: SerializedCommand[]): SlashCommand[] {
  return commands.map(toSlashCommand);
}

/**
 * Match a submitted draft against the catalog by its command token. Returns
 * the matching command and the remaining argument string, or `null` when the
 * draft is not a recognized slash command.
 */
export interface ParsedSlashInput {
  command: SerializedCommand;
  args: string;
}

export function matchSlashInput(
  commands: SerializedCommand[],
  text: string,
): ParsedSlashInput | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1);
  const firstSpace = body.indexOf(" ");
  const token = (firstSpace === -1 ? body : body.slice(0, firstSpace))
    .trim()
    .toLowerCase();
  if (!token) return null;
  const args = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();

  const aliasTarget = `/${token}`;
  const command = commands.find(
    (candidate) =>
      candidate.nativeName.toLowerCase() === token ||
      candidate.key.toLowerCase() === token ||
      candidate.textAliases.some(
        (alias) => alias.toLowerCase() === aliasTarget,
      ),
  );
  if (!command) return null;
  return { command, args };
}

/**
 * What dispatching a matched command should do in the terminal. Pure decision
 * that the TUI executes — keeps the side-effect-free routing testable.
 *
 * - `send` — forward the literal slash text to the agent over the message API.
 * - `navigate-view` — open a view via the existing `/api/views/:id/navigate`
 *   path (only when we can resolve a concrete view id).
 * - `clear` / `new` — local transcript / conversation behavior.
 */
export type SlashDispatch =
  | { kind: "send"; text: string }
  | { kind: "navigate-view"; viewId: string }
  | { kind: "clear" }
  | { kind: "new" };

export function resolveSlashDispatch(
  parsed: ParsedSlashInput,
  text: string,
): SlashDispatch {
  const { command, args } = parsed;
  const target = command.target;

  if (target.kind === "client") {
    if (target.clientAction === "clear-chat") return { kind: "clear" };
    if (target.clientAction === "new-conversation") return { kind: "new" };
    // No terminal behavior for fullscreen/palette/show-commands — let the
    // agent answer (e.g. /help renders its own reply).
    return { kind: "send", text: text.trim() };
  }

  if (target.kind === "navigate") {
    // A view-scoped navigation we can act on locally. A bare `/views <id>`
    // resolves the id from the first argument; a pinned `viewId` wins.
    const viewId =
      target.viewId ??
      (commandHasArgSource(command, "views") && args
        ? args.split(/\s+/)[0]
        : undefined);
    if (viewId) return { kind: "navigate-view", viewId };
    // Tab/section/settings navigation has no terminal equivalent — surface the
    // command to the agent so it can guide the user.
    return { kind: "send", text: text.trim() };
  }

  // Agent target (the default) — send the literal slash text; an action
  // handler produces the reply.
  return { kind: "send", text: text.trim() };
}

function commandHasArgSource(
  command: SerializedCommand,
  source: CommandArgSource,
): boolean {
  return command.args.some((arg) => arg.dynamicChoices === source);
}
