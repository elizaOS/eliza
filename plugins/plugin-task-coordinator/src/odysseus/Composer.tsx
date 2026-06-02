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
  Square,
  Terminal,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

interface SlashCommand {
  name: string;
  label: string;
  run: () => void;
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

  const commands: SlashCommand[] = [
    { name: "new", label: "Start a new chat", run: onNewChat },
    { name: "search", label: "Search conversations", run: onSearch },
    { name: "clear", label: "Clear the message box", run: () => onInput("") },
    {
      name: "theme",
      label: "Open the theme picker",
      run: () => onOpenPanel("theme"),
    },
    { name: "memory", label: "Open memory", run: () => onOpenPanel("memory") },
    { name: "skills", label: "Open skills", run: () => onOpenPanel("skills") },
    { name: "notes", label: "Open notes", run: () => onOpenPanel("notes") },
    {
      name: "settings",
      label: "Open settings",
      run: () => onOpenPanel("settings"),
    },
  ];

  const token =
    input.startsWith("/") && !input.includes(" ")
      ? input.slice(1).toLowerCase()
      : null;
  const matches =
    token === null ? [] : commands.filter((c) => c.name.startsWith(token));
  const slashOpen = matches.length > 0 && !dismissed;
  const selClamped = Math.min(sel, Math.max(0, matches.length - 1));

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
        setSel((s) => (s + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSel((s) => (s - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        runCommand(matches[selClamped]);
        return;
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
        <div className="od-slash-menu">
          {matches.map((command, i) => (
            <button
              type="button"
              key={command.name}
              className={`od-slash-item${i === selClamped ? " active" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runCommand(command)}
            >
              <span className="od-slash-name">/{command.name}</span>
              <span className="od-slash-label">{command.label}</span>
            </button>
          ))}
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
