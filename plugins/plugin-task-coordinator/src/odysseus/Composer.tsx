// odysseus composer (static/index.html .chat-input-bar): a borderless textarea
// with a model-picker chip pinned top-right, a bottom row with the emoji
// control (left) and the send/stop action (right), and a slash-command menu
// (type "/" → filtered commands). The send button swaps to a stop control
// while the agent is working — matching odysseus and the eliza ChatComposer.
//
// Faithfulness note — what the orchestrator backend actually supports:
// `postOrchestratorTaskMessage(taskId, content)` and `createOrchestratorTask`
// take a plain message; there is no attachment, web/shell/rag toggle, mode, or
// per-message model-switch path on the orchestrator client. Odysseus's chatbox
// surfaces those because its backend has them. Rather than ship dead controls
// that route nowhere (the previous web/shell/"+ more"/Agent-Chat-mode buttons
// and the static model label did exactly that), this composer only renders
// surfaces wired to a real client method or shell handler. The attach strip,
// paste/drop, tool toggles, and mode toggle are intentionally absent until the
// orchestrator backend grows those request fields.

import { ArrowUp, ChevronUp, Smile, Square } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmojiPicker } from "./EmojiPicker";

// A leaf entry in the slash-command autocomplete (odysseus
// static/js/slashAutocomplete.js _flatten()). `token` is what gets inserted /
// shown ("/new"), `aliases` are alternative spellings the scorer also matches,
// `category` drives the grouped section headers, `help` is the description,
// `usage` is the right-aligned hint (only rendered when it differs from token).
// `run` is the wired handler — every entry maps to a real Composer prop, so no
// command routes nowhere.
interface SlashCommand {
  token: string;
  aliases: string[];
  category: string;
  help: string;
  usage: string;
  run: () => void;
}

const MAX_VISIBLE = 12;

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
  // model-picker "Add models" / model-management entry point — the orchestrator
  // has no per-message model-switch endpoint, so the chip opens the management
  // surface rather than a fabricated inline switcher. Optional so the contract
  // stays backward-compatible; the chip only renders when it's wired.
  onOpenModels?: () => void;
}): ReactNode {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Insert an emoji at the caret (or append), then restore the caret just past
  // it — the EmojiPicker stays open so several can be picked (odysseus behavior).
  const insertEmoji = (emoji: string) => {
    const el = taRef.current;
    if (el) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      onInput(input.slice(0, start) + emoji + input.slice(end));
      requestAnimationFrame(() => {
        const pos = start + emoji.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    } else {
      onInput(input + emoji);
    }
  };

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

  // The command registry, ordered by category so the grouped headers render in
  // a stable, contiguous order (slashAutocomplete.js groups by `category`, and
  // its _flatten keeps the COMMANDS definition order intact). Metadata
  // (category/help/usage/aliases) is ported from slashCommands.js COMMANDS +
  // the PROMOTED_ALIASES short forms (/new, /clear, /web…). Only commands whose
  // target surface exists in the clone are included — every `run` maps to a
  // real Composer prop (onNewChat / onInput / onSearch / onOpenPanel /
  // onOpenModels). Odysseus's tool-opener commands for surfaces the clone does
  // not host (cookbook/email/gallery/research/compare/todo/event/setup) are
  // omitted rather than shipped as dead rows.
  // The registry is constant per render-set of callback props; rebuilding it on
  // every keystroke is wasted work, so memoize on the wired handlers.
  const commands = useMemo<SlashCommand[]>(
    () => [
      {
        token: "/new",
        aliases: ["/chats new", "/create"],
        category: "Chats",
        help: "Start a new chat",
        usage: "/new",
        run: onNewChat,
      },
      {
        token: "/clear",
        aliases: ["/chats clear"],
        category: "Chats",
        help: "Clear the message box",
        usage: "/clear",
        run: () => onInput(""),
      },
      {
        token: "/search",
        aliases: ["/find"],
        category: "Chats",
        help: "Search conversations",
        usage: "/search query",
        run: onSearch,
      },
      {
        token: "/memory",
        aliases: ["/brain", "/memories"],
        category: "Tools",
        help: "Open memory",
        usage: "/memory",
        run: () => onOpenPanel("memory"),
      },
      {
        token: "/skills",
        aliases: [],
        category: "Tools",
        help: "Open skills",
        usage: "/skills",
        run: () => onOpenPanel("skills"),
      },
      {
        token: "/notes",
        aliases: ["/note"],
        category: "Tools",
        help: "Open notes",
        usage: "/notes",
        run: () => onOpenPanel("notes"),
      },
      // /models is only offered when the models surface is wired (onOpenModels).
      ...(onOpenModels
        ? [
            {
              token: "/models",
              aliases: ["/model"],
              category: "Tools",
              help: "Browse and manage models",
              usage: "/models",
              run: onOpenModels,
            },
          ]
        : []),
      {
        token: "/theme",
        aliases: [],
        category: "Settings",
        help: "Open the theme picker",
        usage: "/theme name",
        run: () => onOpenPanel("theme"),
      },
      {
        token: "/settings",
        aliases: ["/config", "/preferences"],
        category: "Settings",
        help: "Open settings",
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
  // A bare "/" is the "show everything" case: render the whole registry in
  // definition order (which keeps categories contiguous), exactly like
  // slashAutocomplete.js's `all.slice(MAX_VISIBLE)` fallback. Scoring a bare
  // "/" would reorder rows by token length and scatter the category headers
  // (TOOLS appearing twice, etc.), so we skip scoring entirely for it.
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
      {emojiOpen ? (
        <EmojiPicker
          open={emojiOpen}
          onPick={insertEmoji}
          onClose={() => setEmojiOpen(false)}
        />
      ) : null}
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
            title="Manage models"
            onClick={onOpenModels}
          >
            <span>{modelLabel}</span>
            <ChevronUp size={10} />
          </button>
        ) : (
          <span className="od-model-picker-btn od-model-picker-static">
            {modelLabel}
          </span>
        )}
      </div>
      <div className="od-input-bottom">
        <div className="od-input-left">
          <button
            type="button"
            className={`od-icon-btn${emojiOpen ? " active" : ""}`}
            title="Emoji"
            aria-label="Emoji"
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile size={16} />
          </button>
        </div>
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
