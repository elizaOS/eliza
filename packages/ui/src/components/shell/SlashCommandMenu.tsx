import * as React from "react";

import {
  activeArgIndex,
  completeArg,
  completeCommand,
  filterArgChoices,
  filterCommands,
  matchCommand,
  parseSlashDraft,
  resolveSlashExecution,
  type SlashExecution,
} from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import { cn } from "../../lib/utils";

const FLOAT_SHADOW = "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]";

export interface SlashMenuItem {
  id: string;
  /** The bold token: a command alias (e.g. `/settings`) or an arg value. */
  primary: string;
  /** The dim helper line: command description or arg description. */
  secondary: string;
  /** True for a command row, false for an argument-choice row. */
  isCommand: boolean;
  /** True when picking this command drills into its arguments. */
  hasArgs: boolean;
}

export interface SlashMenuState {
  /** Whether the menu should be shown. */
  open: boolean;
  /** "command" while choosing a command, "arg" while choosing an argument. */
  mode: "command" | "arg" | "none";
  items: SlashMenuItem[];
  activeIndex: number;
  /** Header label, e.g. "Commands" or "/settings · section". */
  headerLabel: string;
  setActiveIndex: (index: number) => void;
  move: (delta: number) => void;
  /** Tab behavior — returns the new draft text, or null if nothing to complete. */
  complete: (index?: number) => string | null;
  /** Enter/click behavior — returns the execution to run, or null. */
  resolve: (index?: number) => SlashExecution | null;
}

/**
 * Derive the slash-menu state from the current composer draft + the loaded
 * command catalog. Stateless except for the highlighted index.
 */
export function useSlashMenu(
  draft: string,
  controller: SlashCommandController,
): SlashMenuState {
  const parsed = React.useMemo(() => parseSlashDraft(draft), [draft]);

  const matched = React.useMemo(
    () =>
      parsed.isSlash && parsed.hasSpace
        ? matchCommand(controller.commands, parsed.commandToken)
        : undefined,
    [parsed, controller.commands],
  );

  // Resolve the active argument + its choices when in arg mode.
  const argInfo = React.useMemo(() => {
    if (!matched) return null;
    const argIndex = activeArgIndex(matched, parsed);
    if (argIndex < 0) return null;
    const arg = matched.args[argIndex];
    if (!arg) return null;
    const dynamic = arg.dynamicChoices
      ? controller.resolveChoices(arg.dynamicChoices)
      : [];
    const all = Array.from(new Set([...(arg.choices ?? []), ...dynamic]));
    if (all.length === 0) return null;
    return { arg, choices: filterArgChoices(all, parsed.argQuery) };
  }, [matched, parsed, controller]);

  const mode: SlashMenuState["mode"] = !parsed.isSlash
    ? "none"
    : parsed.hasSpace
      ? argInfo
        ? "arg"
        : "none"
      : "command";

  const commandResults = React.useMemo(
    () =>
      mode === "command"
        ? filterCommands(controller.commands, parsed.commandToken)
        : [],
    [mode, controller.commands, parsed.commandToken],
  );

  const items: SlashMenuItem[] = React.useMemo(() => {
    if (mode === "command") {
      return commandResults.map((c) => ({
        id: c.key,
        primary: c.textAliases[0] ?? `/${c.nativeName}`,
        secondary: c.description,
        isCommand: true,
        hasArgs: c.acceptsArgs && c.args.length > 0,
      }));
    }
    if (mode === "arg" && argInfo) {
      // The header already names the argument; choice rows stay clean (no
      // repeated description on every row).
      return argInfo.choices.map((choice) => ({
        id: `arg:${choice}`,
        primary: choice,
        secondary: "",
        isCommand: false,
        hasArgs: false,
      }));
    }
    return [];
  }, [mode, commandResults, argInfo]);

  const [activeIndex, setActiveIndexState] = React.useState(0);
  // Reset the highlight whenever the visible set changes.
  const itemsSignature = items.map((i) => i.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on item-set change only — itemsSignature IS the trigger, the body uses neither.
  React.useEffect(() => {
    setActiveIndexState(0);
  }, [itemsSignature]);

  const open = mode !== "none" && items.length > 0;

  const setActiveIndex = React.useCallback(
    (index: number) => {
      if (items.length === 0) return;
      const clamped = ((index % items.length) + items.length) % items.length;
      setActiveIndexState(clamped);
    },
    [items.length],
  );

  const move = React.useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      setActiveIndexState((prev) => {
        const next = prev + delta;
        return ((next % items.length) + items.length) % items.length;
      });
    },
    [items.length],
  );

  const complete = React.useCallback(
    (index = activeIndex): string | null => {
      if (mode === "command") {
        const command = commandResults[index];
        return command ? completeCommand(command) : null;
      }
      if (mode === "arg" && argInfo) {
        const choice = argInfo.choices[index];
        return choice ? completeArg(parsed, choice) : null;
      }
      return null;
    },
    [activeIndex, mode, commandResults, argInfo, parsed],
  );

  const resolve = React.useCallback(
    (index = activeIndex): SlashExecution | null => {
      if (mode === "command") {
        const command = commandResults[index];
        if (!command) return null;
        const alias = command.textAliases[0] ?? `/${command.nativeName}`;
        return resolveSlashExecution(command, alias, controller.resolveSection);
      }
      if (mode === "arg" && matched && argInfo) {
        const choice = argInfo.choices[index];
        if (!choice) return null;
        return resolveSlashExecution(
          matched,
          completeArg(parsed, choice),
          controller.resolveSection,
        );
      }
      return null;
    },
    [activeIndex, mode, commandResults, matched, argInfo, parsed, controller],
  );

  const headerLabel =
    mode === "arg" && matched
      ? `${matched.textAliases[0]} · ${argInfo?.arg.name ?? "argument"}`
      : "Commands";

  return {
    open,
    mode,
    items,
    activeIndex: Math.min(activeIndex, Math.max(0, items.length - 1)),
    headerLabel,
    setActiveIndex,
    move,
    complete,
    resolve,
  };
}

/**
 * The inline slash-command suggestion dropdown that floats above the composer.
 * Presentational: the parent owns the {@link SlashMenuState} (via
 * {@link useSlashMenu}) and routes keyboard events to it.
 */
export function SlashCommandMenu({
  state,
  onPick,
  loading,
}: {
  state: SlashMenuState;
  /** Execute the item at index (Enter/click). */
  onPick: (index: number) => void;
  loading?: boolean;
}): React.JSX.Element | null {
  const listboxId = "slash-command-listbox";
  if (!state.open) {
    if (loading) {
      return (
        <div
          className={cn(
            "absolute bottom-full left-0 right-0 z-10 mb-2 rounded-2xl border border-white/12 bg-black/85 px-4 py-3 text-xs text-white/55",
            FLOAT_SHADOW,
          )}
          role="status"
          data-testid="slash-menu-loading"
        >
          loading commands…
        </div>
      );
    }
    return null;
  }

  return (
    // The combobox input (in the composer) owns aria-activedescendant + focus;
    // this listbox is a non-focusable popup the input points to via aria-controls.
    <div
      id={listboxId}
      role="listbox"
      aria-label="Slash commands"
      data-testid="slash-command-menu"
      className={cn(
        "absolute bottom-full left-0 right-0 z-10 mb-2 max-h-[min(46vh,22rem)] overflow-y-auto",
        "rounded-2xl border border-white/14 bg-black/85 py-1.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      <div
        className={cn(
          "px-3.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-white/40",
          FLOAT_SHADOW,
        )}
      >
        {state.headerLabel}
      </div>
      {state.items.map((item, index) => (
        <button
          type="button"
          key={item.id}
          id={`slash-option-${item.id}`}
          role="option"
          aria-selected={index === state.activeIndex}
          data-testid={`slash-option-${index}`}
          data-active={index === state.activeIndex ? "true" : undefined}
          // Mouse-enter highlights. Pointer-down prevents the mouse/pen focus
          // steal (the composer input must keep focus); touch keeps the
          // platform default so iOS/WebKit does not suppress the tap's click.
          // The pick itself fires on click so the engine's native
          // tap-vs-scroll discrimination applies — a touch drag that scrolls
          // this overflowing listbox emits pointercancel and never clicks,
          // whereas the old pointer-down pick executed a command the instant a
          // scroll gesture touched a row (#10722 real-pointer gesture coverage
          // in slash-commands.spec.ts).
          onMouseEnter={() => state.setActiveIndex(index)}
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") e.preventDefault();
          }}
          onClick={() => onPick(index)}
          className={cn(
            "flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors",
            index === state.activeIndex ? "bg-white/15" : "hover:bg-white/8",
          )}
        >
          <span
            className={cn(
              "min-w-0 shrink-0 font-mono text-[13px] text-white/95",
              FLOAT_SHADOW,
            )}
          >
            {item.primary}
          </span>
          {item.secondary ? (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] text-white/55",
                FLOAT_SHADOW,
              )}
            >
              {item.secondary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {item.isCommand && item.hasArgs ? (
            <span
              aria-hidden="true"
              className="shrink-0 text-[11px] text-white/35"
            >
              ⇥
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
