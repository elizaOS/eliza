// odysseus composer (static/index.html .chat-input-bar + .chat-input-bottom): a
// borderless textarea with a model-picker chip pinned top-right, a compact
// send/stop row, and a slash-command menu (type "/" → filtered commands). The
// send button swaps to a stop control while the agent is working.
//
// Faithfulness note — what the orchestrator backend actually supports:
// `postOrchestratorTaskMessage(taskId, content)` and `createOrchestratorTask`
// take a plain message; there is no web/shell/document toggle or per-message
// mode on the orchestrator client. The visible controls below therefore only
// include actions that map to real handlers.

import { ArrowUp, ChevronUp, Square } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// A leaf entry in the slash-command autocomplete (odysseus
// static/js/slashAutocomplete.js _flatten()). `token` is what gets inserted /
// shown ("/new"), `aliases` are alternative spellings the scorer also matches,
// `category` drives the grouped section headers, `help` is the description,
// `usage` is the right-aligned hint (only rendered when it differs from token).
// `run` is the wired handler when the command maps to a real Composer prop.
interface SlashCommand {
  token: string;
  aliases: string[];
  category: string;
  help: string;
  usage: string;
  run?: () => void;
}

const MAX_VISIBLE = 8;

// Prefix wins over substring; an alias match scores below a token match; a
// help-text hit is the weakest signal. Mirrors slashAutocomplete.js
// _scoreMatch(). `query` already starts with "/".
function scoreMatch(entry: SlashCommand, query: string): number {
  const q = query.toLowerCase();
  const t = entry.token.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 + (50 - Math.min(50, t.length - q.length));
  for (const a of entry.aliases) {
    const al = a.toLowerCase();
    if (al === q) return 900;
    if (al.startsWith(q)) return 400;
  }
  if (t.includes(q)) return 100;
  if (entry.help.toLowerCase().includes(q.slice(1))) return 25;
  return 0;
}

export function Composer({
  input,
  onInput,
  onSubmit,
  onStop,
  sending,
  isActive,
  modelLabel,
  onNewChat,
  onSearch,
  onOpenPanel,
  onOpenModels,
}: {
  input: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  sending: boolean;
  isActive: boolean;
  modelLabel: string;
  onNewChat: () => void;
  onSearch: () => void;
  onOpenPanel: (
    panel: "theme" | "memory" | "skills" | "notes" | "settings",
  ) => void;
  // Opens the models surface (the clone's ModelsView). Mirrors odysseus's
  // model-picker entry point — the orchestrator has no per-message model-switch
  // endpoint, so the chip opens the management surface rather than a fabricated
  // inline switcher. Optional so the contract stays backward-compatible; the
  // chip only becomes a button when it's wired.
  onOpenModels?: () => void;
}): ReactNode {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Auto-grow textarea (24px → 200px), matching odysseus. `input` is a
  // trigger-only dep: the effect re-measures the textarea whenever the value
  // changes, even though it reads scrollHeight rather than `input` directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Only surface commands that are wired in this runtime. Upstream odysseus
  // also carries tour/toggle rows for backends this plugin does not expose; the
  // cleanup omits those placeholder commands instead of rendering disabled rows.
  const commands = useMemo<SlashCommand[]>(
    () => [
      {
        token: "/new",
        aliases: ["/create", "/chats new"],
        category: "Chats",
        help: "Create new chat",
        usage: "/new",
        run: onNewChat,
      },
      {
        token: "/memory",
        aliases: ["/brain", "/memories"],
        category: "Memory",
        help: "Open Brain",
        usage: "/memory",
        run: () => onOpenPanel("memory"),
      },
      {
        token: "/skills",
        aliases: [],
        category: "Tools",
        help: "Open Skills",
        usage: "/skills",
        run: () => onOpenPanel("skills"),
      },
      {
        token: "/notes",
        aliases: [],
        category: "Tools",
        help: "Open Notes",
        usage: "/notes",
        run: () => onOpenPanel("notes"),
      },
      {
        token: "/find",
        aliases: ["/search"],
        category: "Utility",
        help: "Search all conversations",
        usage: "/find query",
        run: onSearch,
      },
      // /models is only offered when the models surface is wired (onOpenModels).
      ...(onOpenModels
        ? [
            {
              token: "/models",
              aliases: ["/model"],
              category: "Settings",
              help: "List available models",
              usage: "/models",
              run: onOpenModels,
            },
          ]
        : []),
      {
        token: "/theme",
        aliases: [],
        category: "Settings",
        help: "Change color theme",
        usage: "/theme name",
        run: () => onOpenPanel("theme"),
      },
      {
        token: "/settings",
        aliases: ["/config", "/preferences"],
        category: "Settings",
        help: "Open the Settings panel",
        usage: "/settings",
        run: () => onOpenPanel("settings"),
      },
    ],
    [onNewChat, onSearch, onOpenPanel, onOpenModels],
  );

  // Trigger only when the message starts with "/" (no leading space) and has no
  // newline — we don't autocomplete mid-prose. A trailing space after the
  // command is allowed so a typed-out command still resolves to its row.
  const query =
    input.startsWith("/") && !input.includes("\n") ? input.trim() : null;
  // A bare "/" renders the wired registry in definition order. Scored queries
  // are capped so the menu stays overlay-chat friendly.
  const visible: SlashCommand[] =
    query === null
      ? []
      : query === "/"
        ? commands.slice(0, MAX_VISIBLE)
        : commands
            .map((entry) => ({ entry, score: scoreMatch(entry, query) }))
            .filter((scored) => scored.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_VISIBLE)
            .map((scored) => scored.entry);
  const slashOpen = visible.length > 0 && !dismissed;
  const selClamped = Math.min(sel, Math.max(0, visible.length - 1));

  const runCommand = (command: SlashCommand) => {
    if (!command.run) return;
    onInput("");
    setDismissed(false);
    setSel(0);
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isPlainEnter = event.key === "Enter" && !event.shiftKey;
    const isComposing = event.nativeEvent.isComposing;

    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSel((s) => (s + 1) % visible.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSel((s) => (s - 1 + visible.length) % visible.length);
        return;
      }
      // Tab always inserts/runs the highlighted row. Enter runs the highlighted
      // row while still completing; once the typed text exactly matches a
      // command token/alias (slashAutocomplete.js exactHit), Enter runs that
      // command so "/new" does not get posted as chat text.
      if (event.key === "Tab") {
        event.preventDefault();
        runCommand(visible[selClamped]);
        return;
      }
      if (isPlainEnter && isComposing) {
        return;
      }
      if (isPlainEnter) {
        const typed = query;
        const matchedEntry =
          typed === null
            ? undefined
            : visible.find(
                (entry) =>
                  entry.token === typed || entry.aliases.includes(typed),
              );
        if (!matchedEntry) {
          // Still in completion mode — Enter runs the highlighted row.
          event.preventDefault();
          runCommand(visible[selClamped]);
          return;
        }
        // The typed text exactly matches a command. If it's a wired row, run it
        // (odysseus's submit path parses and executes the slash — here our
        // onSubmit() would post the literal "/new" as a chat message instead).
        if (matchedEntry.run) {
          event.preventDefault();
          runCommand(matchedEntry);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // Enter confirming an IME composition must not submit (chat.js keydown
    // guards submit with !e.isComposing).
    if (isPlainEnter && !isComposing) {
      event.preventDefault();
      onSubmit();
    }
  };

  const onChange = (value: string) => {
    onInput(value);
    setDismissed(false);
    setSel(0);
  };

  const hasDraft = input.trim().length > 0;

  return (
    <div className="od-input-bar">
      {slashOpen ? (
        <div className="od-slash-ac" role="listbox" aria-label="Slash commands">
          {visible.map((command, i) => {
            const showUsage = command.usage !== command.token;
            return (
              <button
                key={command.token}
                type="button"
                role="option"
                aria-selected={i === selClamped}
                className={`od-slash-ac-row${i === selClamped ? " active" : ""}`}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runCommand(command);
                }}
              >
                <span className="od-slash-ac-token">{command.token}</span>
                <span className="od-slash-ac-help">{command.help}</span>
                {showUsage ? (
                  <span className="od-slash-ac-usage">{command.usage}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="od-input-top">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the orchestrator..."
          rows={1}
          aria-label="Message input"
        />
        {onOpenModels ? (
          <button
            type="button"
            className="od-model-picker-btn"
            title="Switch model"
            onClick={onOpenModels}
          >
            <span>{modelLabel}</span>
            <ChevronUp size={10} />
          </button>
        ) : (
          <span className="od-model-picker-btn od-model-picker-static">
            {modelLabel}
            <ChevronUp size={10} />
          </span>
        )}
      </div>
      <div className="od-input-bottom">
        <div className="od-input-left" aria-hidden="true" />
        <div className="od-input-right">
          {isActive ? (
            <button
              type="button"
              className="od-send-btn od-stop"
              onClick={onStop}
              title="Stop"
              aria-label="Stop"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="od-send-btn"
              onClick={onSubmit}
              disabled={!hasDraft || sending}
              title="Send"
              aria-label="Send"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
