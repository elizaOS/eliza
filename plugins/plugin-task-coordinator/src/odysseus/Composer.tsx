// odysseus composer (static/index.html .chat-input-bar + .chat-input-bottom): a
// borderless textarea with a model-picker chip pinned top-right, a bottom row
// (.chat-input-bottom) with the odysseus left icon group (overflow chevron /
// web-search magnifier / shell terminal) and, on the right, the Agent|Chat
// segmented mode toggle followed by the send/stop action. A slash-command menu
// (type "/" → filtered commands) sits above the bar. The send button swaps to a
// stop control while the agent is working — matching odysseus and the eliza
// ChatComposer.
//
// Faithfulness note — what the orchestrator backend actually supports:
// `postOrchestratorTaskMessage(taskId, content)` and `createOrchestratorTask`
// take a plain message; there is no web/shell/document toggle, per-message mode,
// or quick-toggle slash path on the orchestrator client. Odysseus surfaces those
// because its backend has them. For pixel-1:1 chrome the controls below are
// rendered faithfully — the left web/shell icons and the Agent|Chat toggle, and
// the odysseus slash rows for those toggles — but the ones with no orchestrator
// backend are rendered INERT/disabled with an honest title rather than wired to
// a no-op (no fabricated behaviour, no dead-but-clickable rows). Controls that DO
// map to a real handler (new chat / clear / search / open Brain·Notes·Theme·
// Settings / open Models) are fully active. The Agent|Chat toggle is a faithful
// local visual control (the orchestrator has a single message path), defaulting
// to "Chat" to match the captured odysseus frame.

import { ArrowUp, ChevronUp, Search, Square, Terminal } from "lucide-react";
import {
  Fragment,
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
// `run` is the wired handler when the command maps to a real Composer prop;
// `disabled` rows are rendered faithfully (1:1 chrome + copy) but inert with an
// `note` explaining the orchestrator has no backend for them — never a silent
// no-op, never fabricated behaviour.
interface SlashCommand {
  token: string;
  aliases: string[];
  category: string;
  help: string;
  usage: string;
  run?: () => void;
  disabled?: boolean;
  note?: string;
}

const MAX_VISIBLE = 12;

// Honest reason shown on slash rows that odysseus exposes but the orchestrator
// backend does not handle (web/document/bash quick-toggles, todos, tours, fork).
// They render for 1:1 chrome but stay inert rather than no-op or fabricate.
const NO_BACKEND = "Not available in the Orchestrator";

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
  // Agent|Chat mode toggle. The orchestrator has a single message path, so this
  // is a faithful local visual control (not wired to a backend mode field).
  // Defaults to "chat" to match the captured odysseus slash-menu frame, where
  // the Chat segment is the active one.
  const [mode, setMode] = useState<"agent" | "chat">("chat");

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

  // The command registry, ported to mirror the deployed odysseus slash menu
  // (static/js/slashAutocomplete.js _flatten + PROMOTED_ALIASES short forms).
  // The rows, their category headers, help, and usage strings are verbatim from
  // slashCommands.js COMMANDS — the same set/order the real frame renders:
  // /new, /web, /doc, /todo, /demo, /note, /fork, /bash (then /clear, /memory,
  // /settings below the fold). Rows whose target surface exists in the clone are
  // wired to a real Composer prop (onNewChat / onInput / onSearch / onOpenPanel
  // / onOpenModels); odysseus's quick-toggle / todo / tour / fork rows are
  // outside the orchestrator backend, so they render faithfully but DISABLED
  // with an honest title. Memoized on the wired handlers.
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
        token: "/web",
        aliases: ["/search web", "/toggle web"],
        category: "Quick toggles",
        help: "Toggle web search",
        usage: "/web",
        disabled: true,
        note: NO_BACKEND,
      },
      {
        token: "/doc",
        aliases: ["/toggle doc"],
        category: "Quick toggles",
        help: "Toggle document editor",
        usage: "/doc",
        disabled: true,
        note: NO_BACKEND,
      },
      {
        token: "/todo",
        aliases: ["/td"],
        category: "Productivity",
        help: "Add or list todos",
        usage: "/todo Your task  ·  /todo list",
        disabled: true,
        note: NO_BACKEND,
      },
      {
        token: "/demo",
        aliases: ["/tour"],
        category: "Tours",
        help: "Full guided product tour",
        usage: "/demo",
        disabled: true,
        note: NO_BACKEND,
      },
      {
        token: "/note",
        aliases: ["/n"],
        category: "Memory",
        help: "Quick-save a note",
        usage: "/note text",
        disabled: true,
        note: NO_BACKEND,
      },
      {
        token: "/fork",
        aliases: ["/cp", "/chats fork"],
        category: "Chats",
        help: "Fork chat (keep first N msgs)",
        usage: "/fork",
        disabled: true,
        note: NO_BACKEND,
      },
      {
        token: "/bash",
        aliases: ["/shell", "/toggle bash"],
        category: "Quick toggles",
        help: "Toggle bash/shell",
        usage: "/bash",
        disabled: true,
        note: NO_BACKEND,
      },
      // ── below-the-fold rows (MAX_VISIBLE cap) — wired to real surfaces ──
      {
        token: "/clear",
        aliases: ["/chats clear"],
        category: "Chats",
        help: "Clear chat display",
        usage: "/clear",
        run: () => onInput(""),
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
    [onNewChat, onInput, onSearch, onOpenPanel, onOpenModels],
  );

  // Trigger only when the message starts with "/" (no leading space) and has no
  // newline — we don't autocomplete mid-prose. A trailing space after the
  // command is allowed so a typed-out command still resolves to its row.
  const query =
    input.startsWith("/") && !input.includes("\n") ? input.trim() : null;
  // A bare "/" is the "show everything" case: render the registry in its
  // definition order (which preserves odysseus's repeated/non-contiguous
  // category headers — Quick toggles appears for /web,/doc and again for /bash),
  // capped at MAX_VISIBLE exactly like slashAutocomplete.js's all.slice(0,12).
  // Scoring a bare "/" would reorder rows by token length, so we skip it.
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
    if (command.disabled || !command.run) return;
    onInput("");
    setDismissed(false);
    setSel(0);
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
      // Tab always runs the selected row. Enter runs it too, EXCEPT when the
      // typed text already exactly matches a command token/alias — then the
      // popup is in "ready to submit a typed-out command" mode and Enter falls
      // through to the normal submit path (slashAutocomplete.js exactHit).
      if (event.key === "Tab") {
        event.preventDefault();
        runCommand(visible[selClamped]);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const typed = query;
        const exactHit =
          typed !== null &&
          visible.some(
            (entry) => entry.token === typed || entry.aliases.includes(typed),
          );
        if (!exactHit) {
          event.preventDefault();
          runCommand(visible[selClamped]);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
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
            const prev = i > 0 ? visible[i - 1] : null;
            const showCat = prev === null || prev.category !== command.category;
            const showUsage = command.usage !== command.token;
            return (
              <Fragment key={command.token}>
                {showCat ? (
                  <div className="od-slash-ac-cat">{command.category}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === selClamped}
                  aria-disabled={command.disabled ? true : undefined}
                  title={command.disabled ? command.note : undefined}
                  className={`od-slash-ac-row${i === selClamped ? " active" : ""}${
                    command.disabled ? " od-slash-ac-disabled" : ""
                  }`}
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
              </Fragment>
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
        <div className="od-input-left">
          {/* Overflow / expand chevron (odysseus .overflow-plus-btn). The
              orchestrator has no attach/RAG/doc tools menu, so it renders inert
              for 1:1 chrome rather than opening a fabricated menu. */}
          <button
            type="button"
            className="od-icon-btn"
            title="More tools (not available in the Orchestrator)"
            aria-label="More tools"
            aria-disabled="true"
            disabled
          >
            <ChevronUp size={16} />
          </button>
          {/* Web search (odysseus #web-toggle-btn). No orchestrator web-search
              toggle — inert for chrome parity. */}
          <button
            type="button"
            className="od-icon-btn"
            title="Web search (not available in the Orchestrator)"
            aria-label="Web search"
            aria-disabled="true"
            disabled
          >
            <Search size={16} />
          </button>
          {/* Shell access (odysseus #bash-toggle-btn). No orchestrator shell
              toggle — inert for chrome parity. */}
          <button
            type="button"
            className="od-icon-btn"
            title="Shell access (not available in the Orchestrator)"
            aria-label="Shell access"
            aria-disabled="true"
            disabled
          >
            <Terminal size={16} />
          </button>
        </div>
        <div className="od-input-right">
          {/* Agent | Chat segmented toggle (odysseus .mode-toggle). Faithful
              local visual control — the orchestrator has one message path, so
              this does not switch a backend mode; it defaults to Chat to match
              the captured frame. */}
          <div
            className={`od-mode-toggle${mode === "chat" ? " od-mode-chat" : ""}`}
          >
            <button
              type="button"
              className={`od-mode-btn${mode === "agent" ? " active" : ""}`}
              aria-pressed={mode === "agent"}
              onClick={() => setMode("agent")}
            >
              Agent
            </button>
            <button
              type="button"
              className={`od-mode-btn${mode === "chat" ? " active" : ""}`}
              aria-pressed={mode === "chat"}
              onClick={() => setMode("chat")}
            >
              Chat
            </button>
          </div>
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
