// odysseus composer (static/index.html .chat-input-bar): a borderless textarea
// with a model-picker chip pinned top-right, a bottom row of tool icons (left) +
// Agent/Chat mode toggle and the send/stop action (right), and a slash-command
// menu (type "/" → filtered commands). The send button swaps to a stop control
// while the agent is working — matching odysseus and the eliza ChatComposer.

import {
  ArrowUp,
  ChevronUp,
  Globe,
  Plus,
  Smile,
  Square,
  Terminal,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
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
}): ReactNode {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"agent" | "chat">("agent");
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
  // a stable order (slashAutocomplete.js groups by `category`). Metadata
  // (category/help/usage/aliases) is ported from slashCommands.js COMMANDS;
  // every `run` maps to a real Composer prop — the "direct tool slash commands"
  // (/memory, /skills, /notes, /settings) open their panels via onOpenPanel,
  // and /theme opens the theme picker.
  const commands: SlashCommand[] = [
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
      category: "Utility",
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
      aliases: [],
      category: "Tools",
      help: "Open notes",
      usage: "/notes",
      run: () => onOpenPanel("notes"),
    },
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
  ];

  // Trigger only when the message starts with "/" (no leading space) and has no
  // newline — we don't autocomplete mid-prose. A trailing space after the
  // command is allowed so a typed-out command still resolves to its row.
  const query =
    input.startsWith("/") && !input.includes("\n") ? input.trim() : null;
  const matches: SlashCommand[] =
    query === null
      ? []
      : commands
          .map((entry) => ({ entry, score: scoreMatch(entry, query) }))
          .filter((scored) => scored.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_VISIBLE)
          .map((scored) => scored.entry);
  // Bare "/" with no scored hits falls back to the full list (capped), matching
  // upstream's "show everything" behavior for the empty query.
  const visible: SlashCommand[] =
    query === "/" && matches.length === 0
      ? commands.slice(0, MAX_VISIBLE)
      : matches;
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
        <button
          type="button"
          className="od-model-picker-btn"
          title="Switch model"
        >
          <span>{modelLabel}</span>
          <ChevronUp size={10} />
        </button>
      </div>
      <div className="od-input-bottom">
        <div className="od-input-left">
          <button type="button" className="od-icon-btn" title="More tools">
            <Plus size={16} />
          </button>
          <button type="button" className="od-icon-btn" title="Web search">
            <Globe size={16} />
          </button>
          <button type="button" className="od-icon-btn" title="Shell access">
            <Terminal size={16} />
          </button>
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
          <div
            className={`od-mode-toggle${mode === "chat" ? " od-mode-chat" : ""}`}
          >
            <button
              type="button"
              className={`od-mode-btn${mode === "agent" ? " active" : ""}`}
              onClick={() => setMode("agent")}
            >
              Agent
            </button>
            <button
              type="button"
              className={`od-mode-btn${mode === "chat" ? " active" : ""}`}
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
